import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, statSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copilotResourceId, discoverCopilotResources, prepareCopilotResourceHome, type CopilotResources } from './inherited-resources.ts';
import { fileURLToPath } from 'node:url';

const native = (name: string, kind: 'skills' | 'mcpServers') => ({ name: copilotResourceId('copilot', kind, name), nativeName: name, displayName: name, enabled: true, kind });
const catalog: CopilotResources = { skills: [native('Alpha skill', 'skills'), native('Beta skill', 'skills')], mcpServers: [native('Open Brain', 'mcpServers'), native('Composio', 'mcpServers')] };

describe('inherited Copilot resource settings', () => {
  it('uses collision-free policy IDs for native names with spaces, punctuation and different instances', () => {
    const ids = ['Open Brain', 'open-brain', 'Open/Brain', 'Open_Brain'].map(name => copilotResourceId('copilot', 'mcpServers', name));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => /^[a-z][a-z0-9_-]{0,31}$/.test(id))).toBe(true);
    expect(copilotResourceId('another', 'mcpServers', 'Open Brain')).not.toBe(ids[0]);
  });
  it('isolates two threads, respects global disables, changes the process fingerprint and preserves original settings and auth', () => {
    const home = mkdtempSync(join(tmpdir(), 'copilot-policy-test-'));
    const source = join(home, '.copilot'); mkdirSync(source);
    const original = '// Native settings\n{"disabledSkills":["already-disabled"],"disabledMcpServers":[],"model":"fixture",}';
    writeFileSync(join(source, 'settings.json'), original);
    writeFileSync(join(source, 'config.json'), 'fixture-login');
    writeFileSync(join(source, 'mcp-config.json'), '{}');
    const args = { env: { HOME: home }, instanceId: 'copilot', threadId: 'one', catalog, appMcpNames: [] };
    const first = prepareCopilotResourceHome({ ...args, policy: { skills: [catalog.skills[0].name], mcpServers: [catalog.mcpServers[0].name] } });
    const firstSettings = JSON.parse(readFileSync(join(first.COPILOT_HOME!, 'settings.json'), 'utf8'));
    expect(firstSettings.disabledSkills).toEqual(['already-disabled', 'Beta skill']);
    expect(firstSettings.disabledMcpServers).toEqual(['Composio']);
    expect(readFileSync(join(first.COPILOT_HOME!, 'config.json'), 'utf8')).toBe('fixture-login');
    expect(statSync(join(first.COPILOT_HOME!, 'config.json')).mode & 0o777).toBe(0o600);
    const second = prepareCopilotResourceHome({ ...args, threadId: 'two', policy: { skills: [], mcpServers: [] } });
    expect(second.COPILOT_HOME).not.toBe(first.COPILOT_HOME);
    const changed = prepareCopilotResourceHome({ ...args, policy: { skills: [], mcpServers: [] } });
    expect(changed.COPILOTBOT_RESOURCE_POLICY).not.toBe(first.COPILOTBOT_RESOURCE_POLICY);
    expect(readFileSync(join(source, 'settings.json'), 'utf8')).toBe(original);
  });
  it('never disables an approved app-owned MCP that overrides a same-named native server', () => {
    const home = mkdtempSync(join(tmpdir(), 'copilot-collision-test-'));
    const env = prepareCopilotResourceHome({ env: { HOME: home }, instanceId: 'copilot', threadId: 'collision', catalog, appMcpNames: ['Composio'], policy: { skills: null, mcpServers: [] } });
    expect(JSON.parse(readFileSync(join(env.COPILOT_HOME!, 'settings.json'), 'utf8')).disabledMcpServers).toEqual(['Open Brain']);
  });
  it('discovers metadata without ever returning server credentials or commands', async () => {
    const home = mkdtempSync(join(tmpdir(), 'copilot-discovery-test-'));
    const file = join(home, 'native.json');
    writeFileSync(file, JSON.stringify({ skills: [{ name: 'Researcher', enabled: true, source: 'personal-copilot', description: 'Research carefully' }], mcpServers: { 'Open Brain': { enabled: true, source: 'user', url: 'https://private.example', headers: { Authorization: 'DO-NOT-RETURN' } } } }));
    const cli = `${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL('./testing/fake-copilot.mjs', import.meta.url)))}`;
    const result = await discoverCopilotResources(cli, { ...process.env, HOME: home, FAKE_COPILOT_CATALOG: file }, home, 'copilot');
    expect(result.skills[0]).toMatchObject({ displayName: 'Researcher', enabled: true, origin: 'copilot' });
    expect(result.mcpServers[0].displayName).toBe('Open Brain');
    expect(JSON.stringify(result)).not.toMatch(/DO-NOT-RETURN|private\.example|Authorization/);
  });
  it('reads the complete native catalog when it exceeds the stdout pipe buffer', async () => {
    const home = mkdtempSync(join(tmpdir(), 'copilot-large-catalog-test-'));
    const file = join(home, 'native.json');
    writeFileSync(file, JSON.stringify({ skills: Array.from({ length: 1000 }, (_, i) => ({ name: `Native skill ${i}`, description: 'Large inherited catalog', enabled: true })), mcpServers: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`Native server ${i}`, { enabled: true }])) }));
    const cli = `${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL('./testing/fake-copilot.mjs', import.meta.url)))}`;
    const result = await discoverCopilotResources(cli, { ...process.env, HOME: home, FAKE_COPILOT_CATALOG: file }, home, 'copilot');
    expect(result.skills).toHaveLength(1000);
    expect(result.skills.at(-1)?.displayName).toBe('Native skill 999');
    expect(result.mcpServers).toHaveLength(200);
  });
});
