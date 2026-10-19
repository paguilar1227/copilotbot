import { mkdtempSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { OpenBrainRuntime } from './open-brain-runtime.ts';
function fixture() {
  const source = mkdtempSync(join(tmpdir(), 'brain-source-'));
  const data = mkdtempSync(join(tmpdir(), 'brain-data-'));
  writeFileSync(join(source, 'docker-compose.yml'), 'services: {}');
  writeFileSync(join(source, 'runtime.json'), JSON.stringify({version: '0.1.0', revision: '0'.repeat(40), apiVersion: 1}));
  return { source, data, verify: async () => {}, endpoint: 'http://127.0.0.1:3210', platform: 'win32' as const, resources: 'C:\\Program Files\\CopilotBot\\resources' };
}
describe('first-time Open Brain runtime', () => {
  it('reports a missing Docker installation without losing setup recovery', async () => {
    const run = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const runtime = new OpenBrainRuntime({ ...fixture(), run, healthy: async () => false });
    await runtime.start();
    expect(runtime.status()).toMatchObject({ phase: 'docker-missing', busy: false });
    run.mockResolvedValue(undefined);
    await runtime.install('docker');
    expect(run).toHaveBeenLastCalledWith('powershell.exe', expect.arrayContaining(['-Dependency', 'docker', '-File']));
    expect(runtime.status().phase).toBe('restart-required');
  });
  it('distinguishes stopped Docker from installation and retries', async () => {
    const run = vi.fn(async (_command: string, args: string[]) => { if (args[0] === 'info') throw new Error('stopped'); });
    const runtime = new OpenBrainRuntime({ ...fixture(), run, healthy: async () => false });
    await runtime.start();
    expect(runtime.status().phase).toBe('docker-stopped');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('starts the exact bundled source and verifies models before declaring ready', async () => {
    const options = fixture();
    let live = false;
    const run = vi.fn(async (_command: string, args: string[]) => { if (args.includes('--pull')) live = true; });
    const runtime = new OpenBrainRuntime({ ...options, run, healthy: async () => live });
    await Promise.all([runtime.start(), runtime.start()]);
    expect(run).toHaveBeenCalledTimes(6);
    const active = JSON.parse(readFileSync(join(options.data, 'updates.json'), 'utf8')).active.source;
    expect(active).not.toBe(options.source);
    expect(run.mock.calls[2]?.[1]).toContain(join(active, 'docker-compose.yml'));
    expect(run.mock.calls[3]?.[1]).toEqual(expect.arrayContaining(['up', '--wait', 'db', 'ollama']));
    expect(run.mock.calls[4]?.[1]).toEqual(expect.arrayContaining(['up', '--no-deps', '--force-recreate', '--wait', 'app']));
    expect(runtime.status()).toMatchObject({ phase: 'ready', busy: false });
    const env = readFileSync(join(options.data, 'runtime.env'), 'utf8');
    await runtime.start();
    expect(readFileSync(join(options.data, 'runtime.env'), 'utf8')).toBe(env);
    expect(run).toHaveBeenCalledTimes(6);
  });
  it('does not report success after a failed model download and can retry', async () => {
    let fail = true, live = false;
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('--pull')) { if (fail) throw new Error('network'); live = true; }
    });
    const runtime = new OpenBrainRuntime({ ...fixture(), run, healthy: async () => live });
    await runtime.start(); expect(runtime.status().phase).toBe('error');
    fail = false;
    await runtime.start(); expect(runtime.status().phase).toBe('ready');
  });
  it('never installs dependencies for a remote service', async () => {
    const run = vi.fn();
    const runtime = new OpenBrainRuntime({ ...fixture(), endpoint: 'https://brain.example.com', run, healthy: async () => false });
    await runtime.start(); await runtime.install('docker');
    expect(runtime.status().phase).toBe('unmanaged');
    expect(run).not.toHaveBeenCalled();
  });
});

it('retries model verification even when containers already answer health after a failed first setup', async () => {
  let healthy = false;
  let fail = true;
  let pulls = 0;
  const options = fixture();
  const run = async (_command: string, args: string[]) => {
    if (args.includes('up')) healthy = true;
    if (args.includes('--pull')) { pulls++; if (fail) throw new Error('download interrupted'); }
  };
  const runtime = new OpenBrainRuntime({ ...options, run, healthy: async () => healthy });
  await runtime.start(); expect(runtime.status().phase).toBe('error');
  fail = false;
  const restarted = new OpenBrainRuntime({ ...options, run, healthy: async () => healthy });
  await restarted.start();
  expect(restarted.status().phase).toBe('ready');
  expect(pulls).toBe(2);
});

it('recognizes Windows restart exit codes without calling setup a failure', async () => {
  const run = vi.fn().mockRejectedValue(Object.assign(new Error('Restart required'), { code: 3010 }));
  const runtime = new OpenBrainRuntime({ ...fixture(), run, healthy: async () => false });
  await runtime.install('wsl');
  expect(runtime.status()).toMatchObject({ phase: 'restart-required', busy: false });
});


it.each([false, true])('protects existing data from a failing installer migration (legacy installation: %s)', async (legacy) => {
  const options = fixture();
  const resources = mkdtempSync(join(tmpdir(), 'brain-resources-'));
  const previous = join(resources, 'open-brain-runtime-previous');
  cpSync(options.source, previous, { recursive: true });
  let database = 'original session, note and task', files = 'original artifact bytes', healthy = false;
  const calls: string[][] = [];
  const run = async (_command: string, args: string[], _cwd?: string, streams?: {input?: string; output?: string}) => {
    calls.push(args);
    if (args.includes('pg_dump')) writeFileSync(streams!.output!, database);
    if (streams?.output?.endsWith('files.tar')) writeFileSync(streams.output, files);
    if (args.includes('dropdb')) database = '';
    if (args.includes('pg_restore')) database = readFileSync(streams!.input!, 'utf8');
    if (streams?.input?.endsWith('files.tar')) files = readFileSync(streams.input, 'utf8');
    if (args.includes('--force-recreate')) {
      const source = args[args.indexOf('-f') + 1]!.replace(/[\\/]docker-compose.yml$/, '');
      const version = JSON.parse(readFileSync(join(source, 'runtime.json'), 'utf8')).version;
      if (version === '0.1.1') { database = 'partially migrated'; files = 'changed files'; throw new Error('injected migration failure'); }
    }
    if (args.includes('--pull')) healthy = true;
  };
  if (legacy) {
    writeFileSync(join(options.data, 'runtime.env'), 'POSTGRES_PASSWORD=fixture');
    writeFileSync(join(options.data, 'runtime-ready.json'), readFileSync(join(options.source, 'runtime.json')));
    healthy = true;
  } else {
    await new OpenBrainRuntime({ ...options, resources, run, healthy: async () => healthy }).start();
  }
  writeFileSync(join(options.source, 'runtime.json'), JSON.stringify({ version: '0.1.1', revision: '1'.repeat(40), apiVersion: 1 }));
  const upgraded = new OpenBrainRuntime({ ...options, resources, run, healthy: async () => healthy });
  await upgraded.start();
  expect(upgraded.status()).toMatchObject({ phase: 'error', updates: { current: { version: '0.1.0' }, recoveryRequired: false } });
  expect(database).toBe('original session, note and task'); expect(files).toBe('original artifact bytes');
  expect(calls.some(args => args.includes('pg_dump'))).toBe(true);
  expect(calls.some(args => args.includes('pg_restore'))).toBe(true);
  // Reopening the same installer must not repeat a failed migration.
  const count = calls.filter(args => args.includes('pg_dump')).length;
  await new OpenBrainRuntime({ ...options, resources, run, healthy: async () => healthy }).start();
  expect(calls.filter(args => args.includes('pg_dump'))).toHaveLength(count);
});

it('refuses to touch legacy data when the previous runtime cannot be identified', async () => {
  const options = fixture();
  writeFileSync(join(options.data, 'runtime.env'), 'POSTGRES_PASSWORD=fixture');
  const run = vi.fn();
  const runtime = new OpenBrainRuntime({ ...options, run, healthy: async () => true });
  await runtime.start();
  expect(runtime.status().phase).toBe('error');
  expect(runtime.status().message).toContain('data has been left unchanged');
  expect(run).not.toHaveBeenCalled();
});
