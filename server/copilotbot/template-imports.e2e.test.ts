import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { launchVerificationServer, runControlOmb } from '../../scripts/control-omb.ts';

it('validates batches and lets an ordinary bot request imports through a real MCP call and one user decision', async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const api = async (method: string, path: string, body?: unknown, status = 200, origin = true) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { 'content-type': 'application/json', ...(origin ? { origin: fixture.info.url } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.status, `${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const control = (...args: string[]) => runControlOmb([...args, '--url', fixture.info.url]) as Promise<any>;
  const template = (name: string) => `format: copilotbot/bot\nversion: 1\nprofile:\n  name: ${name}\n  approvalMode: full\n  chiefOfStaff: true\nresources:\n  skills: []\n  mcpServers: []\nroutines:\n  - name: Never auto-start\n    prompt: Do not run\n    enabled: true\n    schedule: {type: daily, time: '09:00', weekdays: [1]}\n`;
  try {
    const { bot } = await api('POST', '/api/bots', { name: 'Importer', section: 'Testing' }, 201);
    const before = (await api('GET', '/api/bots')).bots.length;
    const mixed = await api('POST', '/api/copilotbot/bot-templates', { files: [
      { filename: 'many.yaml', yaml: `${template('Alpha')}---\nformat: copilotbot/bot\nversion: 1\nprofile: {}\n` },
      { filename: 'bad.yaml', yaml: 'profile: [broken' },
      { filename: 'beta.yaml', yaml: template('Beta') },
    ] });
    expect(mixed.templates.map((item: any) => Boolean(item.defaults))).toEqual([true, false, false, true]);
    expect(mixed.templates[1].diagnostics[0].path).toBe('profile.name');
    expect((await api('GET', '/api/bots')).bots).toHaveLength(before);
    const path = join(fixture.info.dataDir, 'room-plan.json');
    const plan = { [bot.id]: { turns: [
      { steps: [{ tool: 'import_bot_templates', arguments: { files: [{ filename: 'team.yaml', yaml: `${template('Alpha')}---\n${template('Beta')}` }], reason: 'User asked to import Alpha and Beta' } }], reply: 'Waiting for the import decision.' },
      { reply: 'Import decision received. I will not repeat the import.' },
    ] } };
    writeFileSync(path, JSON.stringify(plan));
    await control('send', '--bot', bot.id, '--text', 'Import these two bot templates.');
    expect((await control('wait', '--bot', bot.id, '--timeout', '30')).status).toBe('needs-user');
    const messages = (await api('GET', `/api/threads/${bot.threadId}/messages`)).messages;
    const card = messages.find((message: any) => message.card?.templateImportRequest)?.card;
    expect(card?.templateImportRequest.entries).toHaveLength(2);
    expect((await api('GET', '/api/bots')).bots).toHaveLength(before);
    const evidencePath = `${path}.evidence.jsonl`;
    expect(existsSync(evidencePath)).toBe(true);
    const first = JSON.parse(readFileSync(evidencePath, 'utf8').trim().split('\n')[0]);
    expect(first.evidence.some((item: any) => item.step?.tool === 'import_bot_templates' && !item.response?.error && !item.response?.result?.isError)).toBe(true);
    const accepted = await api('POST', `/api/threads/${bot.threadId}/respond`, { requestId: card.requestId, behavior: 'allow' });
    expect(accepted.result.result).toBe('applied');
    expect((await control('wait', '--bot', bot.id, '--timeout', '30')).status).toBe('settled');
    const imported = (await api('GET', '/api/bots')).bots.filter((item: any) => ['Alpha', 'Beta'].includes(item.name));
    expect(imported).toHaveLength(2);
    for (const item of imported) {
      expect(Boolean(item.chiefOfStaff)).toBe(false);
      expect(item).toMatchObject({ section: 'Testing', approvalMode: 'ask', mcpServers: [], skillAccess: [] });
    }
    expect((await api('GET', '/api/routines')).routines.filter((item: any) => imported.some((bot: any) => bot.id === item.botId)).every((routine: any) => !routine.enabled)).toBe(true);
    expect((await api('POST', `/api/threads/${bot.threadId}/respond`, { requestId: card.requestId, behavior: 'allow' })).alreadySettled).toBe(true);
    expect((await api('GET', '/api/bots')).bots).toHaveLength(before + 2);
    expect(readFileSync(evidencePath, 'utf8').trim().split('\n')).toHaveLength(2);
    await api('POST', '/api/internal/import-bot-templates', { files: [{ filename: 'unauthorized.yaml', yaml: template('Unauthorized') }], reason: 'No token' }, 401);
  } finally { await fixture.close(); }
}, 90_000);
