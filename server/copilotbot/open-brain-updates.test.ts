import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { OpenBrainUpdates, type RuntimeRun } from './open-brain-updates.ts';
import { extractBrainRelease, latestBrainRelease } from './open-brain-release.ts';
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
function source(path: string, version: string, revision: string) {
  mkdirSync(join(path, 'scripts'), { recursive: true });
  writeFileSync(join(path, 'runtime.json'), JSON.stringify({ version, revision, apiVersion: 1 }));
  writeFileSync(join(path, 'docker-compose.yml'), 'services: {}');
  writeFileSync(join(path, 'Dockerfile'), 'FROM node:24');
  writeFileSync(join(path, 'scripts/verify-models.mjs'), '');
}
async function fixture(options: { badHash?: boolean; unsafe?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'brain-update-test-')), bundled = join(root, 'bundled'), candidate = join(root, 'candidate'), data = join(root, 'data');
  source(bundled, '0.1.0', '0'.repeat(40)); source(candidate, '0.1.1', '1'.repeat(40));
  mkdirSync(data); writeFileSync(join(data, 'runtime.env'), 'POSTGRES_PASSWORD=fixture');
  if (options.unsafe) symlinkSync('/tmp', join(candidate, 'outside'));
  const archive = join(root, 'release.tar.gz'); await tar.c({ cwd: candidate, file: archive, gzip: true }, ['.']);
  const bytes = readFileSync(archive);
  const manifest = { schemaVersion: 1 as const, apiVersion: 1 as const, version: '0.1.1', revision: '1'.repeat(40), archive: 'open-brain-runtime.tar.gz' as const, bytes: bytes.length, sha256: options.badHash ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex') };
  let base = '';
  const server = createServer((req, res) => {
    if (req.url === '/release') res.end(JSON.stringify({ draft: false, prerelease: false, tag_name: 'v0.1.1', assets: ['open-brain-runtime.json', 'open-brain-runtime.tar.gz'].map(name => ({ name, browser_download_url: base + '/' + name })) }));
    else if (req.url === '/open-brain-runtime.json') res.end(JSON.stringify(manifest));
    else res.end(bytes);
  }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const memory = { db: 'saved session, note and task', files: 'original file bytes', version: '0.1.0' };
  const calls: string[][] = []; let failBoot = false, failRestore = false;
  const run: RuntimeRun = async (_command, args, _cwd, files) => {
    calls.push(args);
    if (args.includes('pg_dump')) writeFileSync(files!.output!, memory.db);
    if (files?.output?.endsWith('files.tar')) writeFileSync(files.output, memory.files);
    if (args.includes('dropdb')) { if (failRestore) throw new Error('restore blocked'); memory.db = ''; }
    if (args.includes('pg_restore')) memory.db = readFileSync(files!.input!, 'utf8');
    if (files?.input?.endsWith('files.tar')) memory.files = readFileSync(files.input, 'utf8');
  };
  const config = { data, bundled, projectName: 'test-only', run, feed: base + '/release', changed: () => {}, maintenance: async <T>(action: () => Promise<T>) => action(), boot: async (path: string) => {
    const identity = JSON.parse(readFileSync(join(path, 'runtime.json'), 'utf8'));
    memory.version = identity.version;
    if (identity.version === '0.1.1' && failBoot) { memory.db = 'partially migrated'; memory.files = 'changed during migration'; throw new Error('migration failed'); }
  } };
  return { root, data, archive, manifest, memory, calls, config, updates: new OpenBrainUpdates(config), setFailure: (boot: boolean, restore = false) => { failBoot = boot; failRestore = restore; } };
}
describe('Open Brain update safety', () => {
  it('updates, restores old data, and keeps the newer state available to undo a manual rollback', async () => {
    const f = await fixture(); await f.updates.update();
    expect(f.updates.status().current?.version).toBe('0.1.1');
    expect(f.memory.db).toBe('saved session, note and task');
    expect(f.calls.findIndex(call => call.includes('stop'))).toBeLessThan(f.calls.findIndex(call => call.includes('pg_dump')));
    f.memory.db += ' plus a new note'; f.memory.files += ' plus new file';
    await f.updates.rollback(); expect(f.memory).toEqual({ version: '0.1.0', db: 'saved session, note and task', files: 'original file bytes' });
    await f.updates.rollback(); expect(f.memory.version).toBe('0.1.1'); expect(f.memory.db).toContain('plus a new note'); expect(f.memory.files).toContain('plus new file');
  });
  it('restores the old runtime and exact data when a migration fails', async () => {
    const f = await fixture(); f.setFailure(true);
    await expect(f.updates.update()).rejects.toThrow('migration failed');
    expect(f.memory).toEqual({ version: '0.1.0', db: 'saved session, note and task', files: 'original file bytes' });
    expect(f.updates.status()).toMatchObject({ phase: 'failed', recoveryRequired: false });
  });
  it('recovers a persisted failed transaction after the host restarts', async () => {
    const f = await fixture(); f.setFailure(true, true);
    await expect(f.updates.update()).rejects.toThrow('restore blocked');
    expect(f.updates.recoveryRequired).toBe(true);
    f.setFailure(false);
    const restarted = new OpenBrainUpdates(f.config); await restarted.recover();
    expect(restarted.recoveryRequired).toBe(false);
    expect(f.memory).toEqual({ version: '0.1.0', db: 'saved session, note and task', files: 'original file bytes' });
  });
  it('rejects an altered archive before pausing or changing the current service', async () => {
    const f = await fixture({ badHash: true });
    await expect(f.updates.update()).rejects.toThrow('checksum');
    expect(f.calls).toEqual([]); expect(existsSync(join(f.data, 'backups'))).toBe(false);
  });
  it('rejects archive links before extraction', async () => {
    const f = await fixture({ unsafe: true });
    await expect(extractBrainRelease(f.archive, join(f.root, 'extracted'), { ...f.manifest, url: 'http://127.0.0.1/archive' })).rejects.toThrow('unsafe');
    expect(existsSync(join(f.root, 'extracted/outside'))).toBe(false);
  });
  it('parses the public release protocol and never offers a draft', async () => {
    const f = await fixture(); const release = await latestBrainRelease(f.config.feed);
    expect(release).toMatchObject({ version: '0.1.1', apiVersion: 1, revision: '1'.repeat(40) });
  });
});

it('queues bot captures throughout failed recovery and replays them only after the recovery gate clears', async () => {
  const { OpenBrainIntegration } = await import('./open-brain.ts');
  const directory = mkdtempSync(join(tmpdir(), 'brain-recovery-captures-'));
  const bot = { id: 'bot', name: 'Recovery bot' };
  const sessions: any[] = [], notes: any[] = [];
  const store = { bots: [bot], groups: [], bot: () => bot, tasks: () => [{ threadId: 'thread', title: 'Work' }], groupByThread: () => undefined, taskByThread: () => ({ title: 'Work' }) } as any;
  let recovering = true, requests = 0;
  const request = async (path: string, options?: RequestInit) => {
    requests++;
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    let result: unknown = {};
    if (path === '/api/v1/projects') result = { projects: [] };
    else if (path === '/api/v1/sessions' && body) { sessions.push({ id: 'session', ...body }); result = { session: sessions[0] }; }
    else if (path === '/api/v1/sessions') result = { sessions };
    else if (path.startsWith('/api/v1/content') && body) { notes.push({ id: 'note', ...body }); result = notes[0]; }
    else if (path.startsWith('/api/v1/content')) result = { items: notes };
    return Response.json(result);
  };
  const brain = new OpenBrainIntegration(directory, store, request, () => {}, () => !recovering);
  expect((await brain.record(bot as any, 'thread', { title: 'During recovery', text: 'Do not lose this note', kind: 'note' })).status).toBe('queued');
  expect(requests).toBe(0);
  await brain.sync(); expect(notes).toHaveLength(0); expect(brain.status().pending).toBe(1);
  recovering = false; await brain.sync();
  expect(notes).toHaveLength(1); expect(brain.status().pending).toBe(0);
});
