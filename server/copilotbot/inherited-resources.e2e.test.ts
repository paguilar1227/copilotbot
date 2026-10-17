import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { launchVerificationServer, runControlOmb } from '../../scripts/control-omb.ts';

it('lists inherited resources and enforces individual, team and new-member choices in real dispatched Copilot turns', async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { 'content-type': 'application/json', origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.status, `${path}: ${JSON.stringify(result)}`).toBe(expected); return result;
  };
  const command = (...args: string[]) => runControlOmb([...args, '--url', fixture.info.url]) as Promise<any>;
  try {
    const nativeHome = join(fixture.info.dataDir, '.copilot'); mkdirSync(nativeHome, { recursive: true });
    const originalSettings = JSON.stringify({ disabledSkills: ['Disabled skill'], disabledMcpServers: ['Disabled MCP'], model: 'fixture' });
    writeFileSync(join(nativeHome, 'settings.json'), originalSettings);
    writeFileSync(join(nativeHome, 'config.json'), 'fixture-only authentication');
    writeFileSync(join(fixture.info.dataDir, 'copilot-authenticated'), 'fixture-only');
    const nativeCatalog = join(fixture.info.dataDir, 'native-catalog.json');
    const native = { skills: [
      { name: 'Alpha skill', source: 'personal-copilot', enabled: true },
      { name: 'Beta skill', source: 'personal-agents', enabled: true },
      { name: 'Disabled skill', source: 'personal-copilot', enabled: true },
    ], mcpServers: {
      'Open Brain': { source: 'user', enabled: true, type: 'http', url: 'https://example.invalid', headers: { Authorization: 'NEVER-SHOW-THIS' } },
      'Team MCP': { source: 'user', enabled: true, type: 'local', command: 'false' },
      'Disabled MCP': { source: 'user', enabled: true, type: 'local', command: 'false' },
    } };
    writeFileSync(nativeCatalog, JSON.stringify(native));
    const receipts = join(fixture.info.dataDir, 'native-receipts.jsonl');
    const wrapper = join(fixture.info.dataDir, 'native-fixture.mjs');
    writeFileSync(wrapper, `process.env.FAKE_COPILOT_CATALOG=${JSON.stringify(nativeCatalog)};process.env.FAKE_COPILOT_RECEIPTS=${JSON.stringify(receipts)};await import(${JSON.stringify(new URL('./testing/fake-copilot.mjs', import.meta.url).href)});`);
    await api('PATCH', '/api/instances/copilot', { cli: `${JSON.stringify(process.execPath)} ${JSON.stringify(wrapper)}` });
    const create = async (name: string, section = '') => (await api('POST', '/api/bots', { name, section, modelSelection: { instanceId: 'copilot', model: 'fixture-gpt' } }, 201)).bot;
    const first = await create('Scoped', 'Research');
    const second = await create('Other');
    const available = await api('GET', `/api/copilotbot/bots/${first.id}/resources`);
    expect(available.warnings).toEqual([]);
    expect(JSON.stringify(available)).not.toContain('NEVER-SHOW-THIS');
    const skill = (label: string) => available.catalog.skills.find((row: any) => row.displayName === label).name;
    const mcp = (label: string) => available.catalog.mcpServers.find((row: any) => row.displayName === label).name;
    expect(available.catalog.skills.find((row: any) => row.displayName === 'Disabled skill').enabled).toBe(false);
    expect(available.catalog.mcpServers.find((row: any) => row.displayName === 'Disabled MCP').enabled).toBe(false);
    await api('PUT', '/api/copilotbot/resources?section=Research', { skills: [skill('Alpha skill')], mcpServers: [mcp('Open Brain')] });
    await api('PUT', `/api/copilotbot/bots/${first.id}/resources`, { skills: [skill('Alpha skill'), skill('Beta skill')], mcpServers: [mcp('Open Brain'), mcp('Team MCP')] });
    const run = async (bot: any) => {
      await command('send', '--bot', bot.id, '--text', 'Verify inherited resources.');
      expect((await command('wait', '--bot', bot.id, '--timeout', '30')).status).toBe('settled');
      return JSON.parse(readFileSync(receipts, 'utf8').trim().split('\n').at(-1)!);
    };
    const scoped = await run(first);
    expect(scoped.resources.skills.filter((row: any) => row.enabled).map((row: any) => row.name)).toEqual(['Alpha skill']);
    expect(Object.entries(scoped.resources.mcpServers).filter(([, row]: any) => row.enabled).map(([name]) => name)).toEqual(['Open Brain']);
    const other = await run(second);
    expect(other.resources.skills.filter((row: any) => row.enabled).map((row: any) => row.name)).toEqual(['Alpha skill', 'Beta skill']);
    expect(other.copilotHome).not.toBe(scoped.copilotHome);
    const added = await create('Later member', 'Research');
    const later = await run(added);
    expect(later.resources.skills.filter((row: any) => row.enabled).map((row: any) => row.name)).toEqual(['Alpha skill']);
    await api('PUT', `/api/copilotbot/bots/${first.id}/resources`, { skills: [], mcpServers: [] });
    const none = await run(first);
    expect(none.resources.skills.some((row: any) => row.enabled)).toBe(false);
    expect(Object.values(none.resources.mcpServers).some((row: any) => row.enabled)).toBe(false);
    expect(readFileSync(join(nativeHome, 'settings.json'), 'utf8')).toBe(originalSettings);
    native.skills.push({ name: 'Added later', source: 'personal-copilot', enabled: true }); writeFileSync(nativeCatalog, JSON.stringify(native));
    expect((await api('GET', `/api/copilotbot/bots/${first.id}/resources`)).catalog.skills.some((row: any) => row.displayName === 'Added later')).toBe(true);
  } finally { await fixture.close(); }
}, 90_000);
