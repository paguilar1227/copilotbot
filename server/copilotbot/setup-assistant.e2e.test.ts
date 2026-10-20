import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { launchVerificationServer, runControlOmb } from '../../scripts/control-omb.ts';

it('ships a first-run guide, exports its template and serves live setup facts through the real agent tool', async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { origin: fixture.info.url, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.status).toBe(200); return response.json() as Promise<any>;
  };
  try {
    const [bot] = (await api('/api/bots')).bots;
    expect(bot.title).toBe('Setup and app help');
    expect(bot.soul).toContain('get_copilotbot_guide');
    const roster = (await api('/api/copilotbot/roster')).entries;
    const template = roster.find((entry: any) => entry.name === 'CopilotBot Guide');
    expect(template.activeCopies).toBe(1);
    expect((await api(`/api/copilotbot/roster/bots/${template.id}`)).yaml).toContain('approvalMode: ask');
    const messages = (await api(`/api/threads/${bot.threadId}/messages`)).messages;
    expect(messages[0].text).toContain('Set up Copilot');
    await api('/api/config', 'PUT', { azure: { endpoint: 'https://fixture.openai.azure.com', auth: 'api-key', key: 'private-fixture-key', ttsDeployment: 'voice-output' }, decider: { provider: 'azure', azureDeployment: 'fast-decisions' } });
    const planPath = join(fixture.info.dataDir, 'room-plan.json');
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [{ steps: [
      { tool: 'get_copilotbot_guide', arguments: { topic: 'azure' } },
      { tool: 'get_copilotbot_guide', arguments: { topic: 'decisions' } },
    ], reply: 'Setup facts checked; next use Sign in with Microsoft in Azure Foundry settings.' }] } }));
    const control = (...args: string[]) => runControlOmb([...args, '--url', fixture.info.url]) as Promise<any>;
    await control('send', '--bot', bot.id, '--text', 'Check my setup without creating any resources.');
    expect((await control('wait', '--bot', bot.id, '--timeout', '30')).status).toBe('settled');
    const receipt = readFileSync(`${planPath}.evidence.jsonl`, 'utf8');
    expect(receipt).toContain('voice-output');
    expect(receipt).toContain('fast-decisions');
    expect(receipt).toContain('Sign in with Microsoft');
    expect(receipt).not.toContain('private-fixture-key');
    const unauthenticated = await fetch(fixture.info.url + '/api/internal/copilotbot-guide');
    expect(unauthenticated.status).toBe(401);
  } finally { await fixture.close(); }
}, 90_000);
