import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { PluginHost, pluginFile } from './host.ts';
import { pluginManifestSchema } from '../../shared/plugins.ts';
import { allMcpServers, pluginSkills } from './contributions.ts';
import { pluginRoutes } from './routes.ts';
import { json, readBody } from '../harness/http.ts';
import { customMcpServers } from '../config.ts';
import { intersectResources } from '../copilotbot/resource-access.ts';
import { availableLibrarySkills, availableSkillAssignments, installLibrarySkill, librarySkillFilePath, listLibrarySkills, readLibrarySkillFile } from '../skill-library.ts';

const hosts: PluginHost[] = [], servers: Server[] = [];
const temporary = () => mkdtempSync(join(tmpdir(), 'copilotbot-plugin-test-'));
function host(root = temporary()) { const result = new PluginHost(root); hosts.push(result); return result; }
async function ready(instance: PluginHost, id: string) {
  while (instance.get(id).runtime?.status === 'starting') await pause(5);
  expect(instance.list().find(plugin => plugin.manifest.id === id)?.status).toBe('ready');
}
async function listen(server: Server) {
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function sample(id = 'sample', backend = `export function activate(ctx) { return { commands: { 'echo': async input => { await ctx.storage.set('last', input); return ctx.storage.get('last'); }, 'read': () => ctx.storage.get('last') } }; }`) {
  const directory = temporary(); mkdirSync(join(directory, 'ui'));
  writeFileSync(join(directory, 'plugin.json'), JSON.stringify({ format: 'copilotbot.plugin', apiVersion: 1, id, name: id, version: '1.0.0', description: 'Independent extension', backend: 'main.mjs', commands: [{ id: 'echo', title: 'Echo' }, { id: 'read', title: 'Read' }], pages: [{ id: 'main', title: 'Main', entry: 'ui/index.html' }] }));
  writeFileSync(join(directory, 'main.mjs'), backend);
  writeFileSync(join(directory, 'ui/index.html'), '<!doctype html><html><head><title>Example</title></head><body>Example</body></html>');
  return directory;
}
afterEach(async () => { await Promise.all(hosts.splice(0).map(instance => instance.close())); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolveDone => { server.closeAllConnections(); server.close(() => resolveDone()); }))); });

describe('generic extension lifecycle', () => {
  it('installs immutable copies, independently runs two plugins, and restores settings/storage after restart', async () => {
    const root = temporary(), instance = host(root), source = sample();
    await instance.start(); await instance.install(source); await instance.install(sample('another'));
    writeFileSync(join(source, 'main.mjs'), 'invalid source after installation');
    for (const id of ['sample', 'another']) { await instance.enable(id, true); await ready(instance, id); }
    expect(await instance.invoke('sample', 'echo', { task: 'first' })).toEqual({ task: 'first' });
    expect(await instance.invoke('another', 'read', null)).toBeNull();
    await expect(instance.install(source)).rejects.toThrow('Disable');
    await instance.close();
    const restarted = host(root); await restarted.start(); await ready(restarted, 'sample');
    expect(await restarted.invoke('sample', 'read', null)).toEqual({ task: 'first' });
    await restarted.enable('sample', false);
    await expect(restarted.invoke('sample', 'read', null)).rejects.toThrow('not ready');
    expect(() => restarted.asset('sample', 'ui/index.html')).toThrow('disabled');
    expect(await restarted.invoke('another', 'read', null)).toBeNull();
  });

  it('serializes concurrent toggles so the final disabled state owns no worker', async () => {
    const instance = host(); await instance.install(sample());
    await Promise.all([instance.enable('sample', true), instance.enable('sample', false)]);
    expect(instance.get('sample').runtime).toBeUndefined(); expect(instance.list()[0]!.enabled).toBe(false);
  });

  it('installs a plugin needing credentials before asking for its required settings', async () => {
    const source = sample(), file = join(source, 'plugin.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.settings = { token: { type: 'secret', label: 'Access token', required: true } };
    writeFileSync(file, JSON.stringify(manifest));
    const instance = host();
    expect((await instance.install(source)).status).toBe('disabled');
    await expect(instance.enable('sample', true)).rejects.toThrow('Access token is required');
    await instance.configure('sample', { token: 'private-value' });
    await instance.enable('sample', true); await ready(instance, 'sample');
    expect(instance.list()[0]!.configuredSecrets).toEqual(['token']);
    expect(JSON.stringify(instance.list())).not.toContain('private-value');
  });

  it('keeps an unreadable index intact and leaves the host available for diagnosis', async () => {
    const root = temporary(); writeFileSync(join(root, 'plugins.json'), '{bad json');
    const instance = host(root); await instance.start();
    expect(instance.error).toContain('could not be read');
    await expect(instance.install(sample())).rejects.toThrow('could not be read');
    expect(readFileSync(join(root, 'plugins.json'), 'utf8')).toBe('{bad json');
  });

  it('does not turn saved secrets into public settings when a plugin upgrade changes their type', async () => {
    const source = sample(), file = join(source, 'plugin.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.settings = { token: { type: 'secret', label: 'Secret' } };
    writeFileSync(file, JSON.stringify(manifest));
    const instance = host(); await instance.install(source); await instance.configure('sample', { token: 'secret-from-v1' });
    manifest.version = '2.0.0'; manifest.settings.token.type = 'text';
    writeFileSync(file, JSON.stringify(manifest));
    await instance.install(source);
    expect(JSON.stringify(instance.list())).not.toContain('secret-from-v1');
    expect(instance.list()[0]!.settings.token).toBe('');
  });

  it('lets an incomplete MCP service be configured after a rejected enable attempt', async () => {
    const source = sample(), file = join(source, 'plugin.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.settings = { endpoint: { type: 'url', label: 'Address' } };
    manifest.services = { example: { urlSetting: 'endpoint' } };
    manifest.mcp = [{ name: 'plugin_example', service: 'example', path: '/mcp' }];
    writeFileSync(file, JSON.stringify(manifest));
    const instance = host(); await instance.install(source);
    await expect(instance.enable('sample', true)).rejects.toThrow();
    expect((await instance.enable('sample', false)).enabled).toBe(false);
    await instance.configure('sample', { endpoint: 'http://127.0.0.1:3210' });
    await instance.enable('sample', true); await ready(instance, 'sample');
    expect(instance.list()[0]!.status).toBe('ready');
    await instance.enable('sample', false);
    expect((await instance.install(source)).enabled).toBe(false);
  });

  it('contains startup and runtime failures without taking down another extension', async () => {
    const instance = host(); await instance.install(sample()); await instance.install(sample('broken', 'throw new Error("failed activation")'));
    await instance.enable('sample', true); await instance.enable('broken', true); await ready(instance, 'sample');
    while (instance.get('broken').runtime?.status === 'starting') await pause(5);
    expect(instance.list().find(plugin => plugin.manifest.id === 'broken')?.status).toBe('error');
    expect(await instance.invoke('sample', 'echo', 'still available')).toBe('still available');
    await expect(instance.invoke('sample', 'unknown', null)).rejects.toThrow('Unknown');
  });

  it('rejects incompatible versions, path traversal, symlinks, and secret defaults', async () => {
    const instance = host(), source = sample();
    const manifest = JSON.parse(readFileSync(join(source, 'plugin.json'), 'utf8'));
    expect(pluginManifestSchema.safeParse({ ...manifest, apiVersion: 2 }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...manifest, backend: '../escape.mjs' }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...manifest, settings: { key: { type: 'secret', label: 'Key', default: 'never expose' } } }).success).toBe(false);
    expect(() => pluginFile(source, '../plugin.json')).toThrow();
    symlinkSync(join(source, 'main.mjs'), join(source, 'ui', 'link.js'));
    await expect(instance.install(source)).rejects.toThrow('regular files');
    await expect(instance.install('relative/folder')).rejects.toThrow('absolute');
  });
});

describe('Open Brain Lite extension and authenticated routes', () => {
  it('cancels pending commands and service requests when the extension is disabled', async () => {
    let observed!: () => void;
    const incoming = new Promise<void>(resolveObserved => { observed = resolveObserved; });
    const endpoint = await listen(createServer(() => observed()));
    const instance = host(); await instance.install(resolve('plugins/open-brain-lite'));
    await instance.configure('open-brain-lite', { endpoint });
    await instance.enable('open-brain-lite', true); await ready(instance, 'open-brain-lite');
    const pending = instance.invoke('open-brain-lite', 'status', null);
    const rejected = expect(pending).rejects.toThrow('Plugin stopped');
    await incoming; await instance.enable('open-brain-lite', false); await rejected;
    expect(allMcpServers()).toEqual({});
  });

  it('uses the declared service, keeps secrets server-side, and provides scoped-only brain skills', async () => {
    const requests: Array<{ path: string; authorization: string | undefined; body: unknown }> = [];
    const endpoint = await listen(createServer(async (req, res) => {
      requests.push({ path: req.url!, authorization: req.headers.authorization, body: req.method === 'POST' ? await readBody(req) : null });
      json(res, 200, req.url === '/health' ? { ok: true, service: 'open-brain-lite' } : { project: { id: '11111111-1111-4111-8111-111111111111' }, status: 'pending' });
    }));
    const instance = host(); await instance.install(resolve('plugins/open-brain-lite'));
    await instance.configure('open-brain-lite', { endpoint, apiToken: 'private-test-token' });
    await instance.enable('open-brain-lite', true); await ready(instance, 'open-brain-lite');
    expect(await instance.invoke('open-brain-lite', 'status', null)).toMatchObject({ ok: true });
    await instance.invoke('open-brain-lite', 'capture-note', { projectId: '11111111-1111-4111-8111-111111111111', title: 'Decision', content: 'Use the durable project API' });
    expect(requests[1]).toMatchObject({ path: '/api/v1/content', authorization: 'Bearer private-test-token', body: { type: 'note', title: 'Decision', project_ids: ['11111111-1111-4111-8111-111111111111'] } });
    expect(JSON.stringify(instance.list())).not.toContain('private-test-token');
    expect(allMcpServers().plugin_open_brain_lite).toBeUndefined();
    expect(customMcpServers({} as never, [])).toEqual({});
    expect(Object.keys(customMcpServers({} as never, intersectResources(['plugin_open_brain_lite'], ['plugin_open_brain_lite']) ?? undefined))).toEqual([]);
    expect(pluginSkills()[0]?.name).toBe('open-brain-lite');
    expect(listLibrarySkills().find(skill => skill.name === 'open-brain-lite')?.enabled).toBe(true);
    expect(readFileSync(librarySkillFilePath('open-brain-lite'), 'utf8')).toContain('brain_record');
    expect(readLibrarySkillFile('open-brain-lite')).toContain('brain_record');
    installLibrarySkill({ name: 'ordinary', instructions: '---\nname: ordinary\ndescription: Ordinary disabled library\n---\nInstructions', source: 'local-test' });
    expect(availableLibrarySkills({} as never).map(skill => skill.name)).toEqual(['open-brain-lite']);
    expect(availableSkillAssignments({} as never, ['ordinary', 'open-brain-lite'])).toEqual(['open-brain-lite']);
    await instance.setSkillEnabled('open-brain-lite', false);
    expect(listLibrarySkills().find(skill => skill.name === 'open-brain-lite')?.enabled).toBe(false);
    expect(instance.list()[0]!.status).toBe('ready');
    expect(allMcpServers().plugin_open_brain_lite).toBeUndefined();
    await instance.setSkillEnabled('open-brain-lite', true);
    await instance.enable('open-brain-lite', false);
    expect(allMcpServers()).toEqual({}); expect(pluginSkills()).toEqual([]);
    expect(listLibrarySkills().find(skill => skill.name === 'open-brain-lite')).toBeUndefined();
  });

  it('gates every plugin route, injects a sandbox bridge, and refuses untrusted installation', async () => {
    const instance = host(); await instance.install(sample()); await instance.enable('sample', true); await ready(instance, 'sample');
    const route = pluginRoutes(instance);
    const url = await listen(createServer(async (req, res) => {
      const parsed = new URL(req.url!, 'http://fixture');
      await route({ req, res, url: parsed, path: parsed.pathname, method: req.method!, auth: { kind: 'loopback', scopes: req.headers['x-owner'] === 'true' ? ['admin', 'client'] : ['client'] }, json, readBody });
    }));
    expect((await fetch(`${url}/api/plugins`)).status).toBe(403);
    expect((await fetch(`${url}/api/plugins/sample/assets/ui/index.html`)).status).toBe(403);
    const asset = await fetch(`${url}/api/plugins/sample/assets/ui/index.html`, { headers: { 'x-owner': 'true' } });
    expect(asset.headers.get('content-security-policy')).toContain('sandbox allow-scripts allow-forms');
    expect(asset.headers.get('content-security-policy')).toContain("form-action 'none'");
    expect(await asset.text()).toContain('window.copilotbot');
    const refused = await fetch(`${url}/api/plugins/install`, { method: 'POST', headers: { 'x-owner': 'true' }, body: JSON.stringify({ directory: sample() }) });
    expect(refused.status).toBe(400);
  });

  it('lets the library switch disable and re-enable a plugin skill without disabling the plugin', async () => {
    const root = temporary(), instance = host(root);
    await instance.install(resolve('plugins/open-brain-lite')); await instance.enable('open-brain-lite', true); await ready(instance, 'open-brain-lite');
    const route = pluginRoutes(instance);
    const url = await listen(createServer(async (req, res) => {
      const parsed = new URL(req.url!, 'http://fixture');
      await route({ req, res, url: parsed, path: parsed.pathname, method: req.method!, auth: { kind: 'loopback', scopes: ['admin', 'client'] }, json, readBody });
    }));
    const response = await fetch(`${url}/api/skills-library/open-brain-lite`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
    expect(response.status).toBe(200);
    expect(listLibrarySkills().find(skill => skill.name === 'open-brain-lite')?.enabled).toBe(false);
    await instance.close(); const restarted = host(root); await restarted.start(); await ready(restarted, 'open-brain-lite');
    expect(listLibrarySkills().find(skill => skill.name === 'open-brain-lite')?.enabled).toBe(false);
    await restarted.setSkillEnabled('open-brain-lite', true);
    expect(listLibrarySkills().find(skill => skill.name === 'open-brain-lite')?.enabled).toBe(true);
  });
});

it('blocks Open Brain commands and direct service requests during maintenance and resumes afterward', async () => {
  let available = true, writes = 0;
  const endpoint = await listen(createServer(async (req, res) => {
    if (req.method === 'POST') writes++;
    json(res, 200, { ok: true });
  }));
  const instance = new PluginHost(temporary(), () => {}, undefined, id => id !== 'open-brain-lite' || available);
  hosts.push(instance);
  await instance.install(resolve('plugins/open-brain-lite'));
  await instance.configure('open-brain-lite', { endpoint });
  await instance.enable('open-brain-lite', true); await ready(instance, 'open-brain-lite');
  available = false;
  await expect(instance.invoke('open-brain-lite', 'capture-note', { projectId: '11111111-1111-4111-8111-111111111111', title: 'Must wait', content: 'Keep this out of the snapshot window' })).rejects.toMatchObject({ status: 503 });
  await expect(instance.requestService('open-brain-lite', 'brain', '/api/v1/content', { method: 'POST' })).rejects.toMatchObject({ status: 503 });
  expect(writes).toBe(0);
  available = true;
  await instance.invoke('open-brain-lite', 'capture-note', { projectId: '11111111-1111-4111-8111-111111111111', title: 'Resume', content: 'Now the update is finished' });
  expect(writes).toBe(1);
});
