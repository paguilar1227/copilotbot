import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { launchVerificationServer, runControlOmb } from '../../scripts/control-omb.ts';

it('imports, adds, selects and round-trips a large MCP catalog through bot and team APIs', async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { 'content-type': 'application/json', origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json() as any;
    expect(response.status, JSON.stringify(data)).toBe(status);
    return data;
  };
  try {
    const entries = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`service-${i}`, { command: 'fixture' }]));
    const imported = await api('POST', '/api/mcp/servers/import', { json: JSON.stringify({ mcpServers: entries }) }, 201);
    expect(imported.added).toHaveLength(200);
    await api('POST', '/api/mcp/servers', { name: 'extra', command: 'fixture' }, 201);
    const names = [...Object.keys(entries), 'extra'];
    const { bot } = await api('POST', '/api/bots', { name: 'Large catalog', section: 'Large team', settings: { mcpServers: names } }, 201);
    await api('PATCH', `/api/bots/${bot.id}`, { mcpServers: names });
    await api('PUT', '/api/copilotbot/resources?section=Large%20team', { skills: null, mcpServers: names });
    const saved = await api('PUT', `/api/copilotbot/bots/${bot.id}/resources`, { skills: null, mcpServers: names });
    expect(saved.policy.mcpServers).toEqual(names);
    expect(saved.effective.mcpServers).toEqual(names);
    expect(saved.catalog.mcpServers).toHaveLength(201);
    const exported = await api('GET', `/api/copilotbot/bots/${bot.id}/template`);
    const parsed = await api('POST', '/api/copilotbot/bot-template', { yaml: exported.yaml });
    expect(parsed.defaults.profile.mcpServers).toEqual(names);
    await api('PUT', `/api/copilotbot/bots/${bot.id}/resources`, { skills: null, mcpServers: [...names, 'agents'] }, 400);
  } finally { await fixture.close(); }
}, 90_000);

it('enforces bot/team resources in dispatched turns and imports templates without starting work', async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { 'content-type': 'application/json', origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json() as any;
    expect(response.status, JSON.stringify(data)).toBe(status);
    return data;
  };
  const control = (...args: string[]) => runControlOmb([...args, '--url', fixture.info.url]) as Promise<any>;
  try {
    const { bot } = await api('POST', '/api/bots', { name: 'Resource fixture', section: 'Research' }, 201);
    for (const name of ['research', 'writing']) await api('POST', `/api/bots/${bot.id}/skill-template`, {
      name, description: `Fixture ${name}`, source: 'fixture', text: `---\nname: ${name}\ndescription: Fixture ${name}\n---\nUse this synthetic skill.`, enabled: true, warnings: [],
    }, 201);
    const command = { command: process.execPath, args: ['--experimental-strip-types', fileURLToPath(new URL('../testing/fake-mcp-server.ts', import.meta.url))] };
    await api('POST', '/api/mcp/servers/import', { json: JSON.stringify({ notes: command, extra: command }) }, 201);
    for (const name of ['notes', 'extra']) await api('PATCH', `/api/mcp/servers/${name}`, { enabled: true });
    await api('PUT', '/api/copilotbot/resources?section=Research', { skills: ['research'], mcpServers: ['notes'] });
    const selected = await api('PUT', `/api/copilotbot/bots/${bot.id}/resources`, { skills: ['research', 'writing'], mcpServers: ['notes', 'extra'] });
    expect(selected.effective).toEqual({ skills: ['research'], mcpServers: ['notes'] });
    expect(existsSync(join(fixture.info.dataDir, 'workspaces', bot.id, '.claude/skills/research'))).toBe(true);
    expect(existsSync(join(fixture.info.dataDir, 'workspaces', bot.id, '.claude/skills/writing'))).toBe(false);
    const exported = await api('GET', `/api/copilotbot/bots/${bot.id}/template`);
    const before = (await api('GET', '/api/bots')).bots.length;
    const imported = await api('POST', '/api/copilotbot/bot-template', { yaml: exported.yaml });
    expect((await api('GET', '/api/bots')).bots).toHaveLength(before);
    expect(imported.defaults.profile).toMatchObject({ name: 'Resource fixture', skillAccess: ['research'], mcpServers: ['notes'] });
    expect(imported.warnings.join(' ')).toContain('research');
    await api('POST', '/api/copilotbot/bot-template', { yaml: 'format: copilotbot/bot\nversion: 99' }, 400);
    await control('send', '--bot', bot.id, '--text', 'Reply briefly.');
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, 'utf8'));
    expect(dump.mcpConfig.mcpServers).toHaveProperty('notes');
    expect(dump.mcpConfig.mcpServers).not.toHaveProperty('extra');
    expect(dump.systemPrompt).toContain('- research:');
    expect(dump.systemPrompt).not.toContain('- writing:');
    expect((await control('wait', '--bot', bot.id, '--timeout', '30')).status).toBe('settled');
    const { channel } = await control('new-channel', '--name', 'Resource room', '--members', bot.id);
    rmSync(fixture.fixtureDumpPath, { force: true });
    await control('send-channel', '--channel', channel.id, '--text', 'Reply once.');
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    const room = JSON.parse(readFileSync(fixture.fixtureDumpPath, 'utf8'));
    expect(room.mcpConfig.mcpServers).toHaveProperty('notes');
    expect(room.mcpConfig.mcpServers).not.toHaveProperty('extra');
    expect(room.systemPrompt).toContain('- research:');
    expect(room.systemPrompt).not.toContain('- writing:');
    await control('wait', '--channel', channel.id, '--timeout', '30');
    const { bot: added } = await api('POST', '/api/bots', { name: 'Added later', section: 'Research' }, 201);
    expect((await api('GET', `/api/copilotbot/bots/${added.id}/resources`)).effective).toEqual({ skills: ['research'], mcpServers: ['notes'] });
    await api('PUT', `/api/copilotbot/bots/${bot.id}/resources`, { skills: [], mcpServers: [] });
    expect((await api('GET', `/api/copilotbot/bots/${bot.id}/resources`)).effective).toEqual({ skills: [], mcpServers: [] });
    expect(existsSync(join(fixture.info.dataDir, 'workspaces', bot.id, '.claude/skills/research'))).toBe(false);
    rmSync(fixture.fixtureDumpPath, { force: true });
    await control('send', '--bot', bot.id, '--text', 'Verify revoked resources.');
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    const revoked = JSON.parse(readFileSync(fixture.fixtureDumpPath, 'utf8'));
    expect(revoked.mcpConfig.mcpServers).not.toHaveProperty('notes');
    expect(revoked.systemPrompt).not.toContain('- research:');
    expect((await control('wait', '--bot', bot.id, '--timeout', '30')).status).toBe('settled');
    await api('PUT', '/api/copilotbot/resources?section=Research', { skills: null, mcpServers: ['agents'] }, 400);
    const pending = await api('POST', '/api/auth/pairing', { scopes: ['client'] });
    const paired = await api('POST', '/api/auth/pair', { code: pending.code, label: 'Fixture client' });
    const clientResponse = await fetch(`${fixture.info.url}/api/copilotbot/bots/${bot.id}/resources`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${paired.token}` }, body: JSON.stringify({ skills: null, mcpServers: null }) });
    expect(clientResponse.status).toBe(403);
  } finally { await fixture.close(); }
}, 90_000);

it('refuses busy changes and cross-bot privilege expansion through bare loopback', async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: 'hang' });
  const request = async (method: string, path: string, body?: unknown, browser = true) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { 'content-type': 'application/json', ...(browser ? { origin: fixture.info.url } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any };
  };
  const control = (...args: string[]) => runControlOmb([...args, '--url', fixture.info.url]) as Promise<any>;
  try {
    const { data: { bot: working } } = await request('POST', '/api/bots', { name: 'Working', section: 'Busy team' });
    const { data: { bot: idle } } = await request('POST', '/api/bots', { name: 'Idle', section: 'Idle team' });
    expect((await request('PUT', `/api/copilotbot/bots/${idle.id}/resources`, { skills: [], mcpServers: [] })).status).toBe(200);
    expect((await request('PUT', '/api/copilotbot/resources?section=Idle%20team', { skills: [], mcpServers: [] })).status).toBe(200);
    await control('send', '--bot', working.id, '--text', 'Stay active.');
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    expect((await request('PUT', `/api/copilotbot/bots/${working.id}/resources`, { skills: [], mcpServers: [] })).status).toBe(409);
    expect((await request('PATCH', `/api/bots/${working.id}`, { section: 'Idle team' })).status).toBe(409);
    expect((await request('PUT', '/api/sidebar-sections?section=Idle%20team', { addBotIds: [working.id], removeBotIds: [] })).status).toBe(409);
    expect((await request('PUT', `/api/copilotbot/bots/${idle.id}/resources`, { skills: null, mcpServers: null }, false)).status).toBe(409);
    expect((await request('PATCH', `/api/bots/${idle.id}`, { skillAccess: null }, false)).status).toBe(409);
    expect((await request('PUT', '/api/copilotbot/resources?section=Idle%20team', { skills: null, mcpServers: null }, false)).status).toBe(409);
    await control('interrupt', '--bot', working.id);
    await control('wait', '--bot', working.id, '--timeout', '30');
    expect((await request('PUT', `/api/copilotbot/bots/${idle.id}/resources`, { skills: null, mcpServers: null }, false)).status).toBe(200);
  } finally { await fixture.close(); }
}, 60_000);
