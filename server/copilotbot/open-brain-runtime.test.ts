import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { OpenBrainRuntime } from './open-brain-runtime.ts';
function fixture() {
  const source = mkdtempSync(join(tmpdir(), 'brain-source-'));
  const data = mkdtempSync(join(tmpdir(), 'brain-data-'));
  writeFileSync(join(source, 'docker-compose.yml'), 'services: {}');
  return { source, data, endpoint: 'http://127.0.0.1:3210', platform: 'win32' as const, resources: 'C:\\Program Files\\CopilotBot\\resources' };
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
    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls[2]?.[1]).toContain(join(options.source, 'docker-compose.yml'));
    expect(runtime.status()).toMatchObject({ phase: 'ready', busy: false });
    const env = readFileSync(join(options.data, 'runtime.env'), 'utf8');
    await runtime.start();
    expect(readFileSync(join(options.data, 'runtime.env'), 'utf8')).toBe(env);
    expect(run).toHaveBeenCalledTimes(4);
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
