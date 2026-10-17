import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { launchVerificationServer, runControlOmb } from '../../scripts/control-omb.ts';

it('sets up Copilot with a device code and runs a selected model and effort through the real server', async () => {
  const fixture = await launchVerificationServer();
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json() as Record<string, any>;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  try {
    const fake = fileURLToPath(new URL('./testing/fake-copilot.mjs', import.meta.url));
    await request('/api/instances/copilot', 'PATCH', { cli: `${JSON.stringify(process.execPath)} ${JSON.stringify(fake)}` });
    let info = (await request('/api/instances')).instances.find((i: { instanceId: string }) => i.instanceId === 'copilot');
    expect(info.snapshot).toMatchObject({ state: 'available', authenticated: false });
    expect(info.authentication).toMatchObject({ method: 'device-code' });
    const { auth } = await request('/api/instances/copilot/auth/start', 'POST');
    expect(auth).toMatchObject({ phase: 'waiting', userCode: 'ABCD-EFGH', authorizationUrl: 'https://github.com/login/device' });
    await expect.poll(async () => (await request(`/api/instances/copilot/auth/status?flowId=${auth.flowId}`)).auth.phase, { timeout: 10000 }).toBe('succeeded');
    info = (await request('/api/instances')).instances.find((i: { instanceId: string }) => i.instanceId === 'copilot');
    expect(info.snapshot.authenticated).toBe(true);
    await expect.poll(async () => {
      const refreshed = (await request('/api/instances')).instances.find((i: { instanceId: string }) => i.instanceId === 'copilot');
      return refreshed.models.options.map((m: { id: string }) => m.id);
    }, { timeout: 10000 }).toEqual(['fixture-gpt', 'fixture-claude']);
    const control = (args: string[]) => runControlOmb([...args, '--url', fixture.info.url]);
    const result = await control(['new-bot', '--name', 'Copilot acceptance']) as { bot: { id: string; activeTaskId: string } };
    const { bot } = result;
    await request(`/api/bots/${bot.id}/tasks/${bot.activeTaskId}`, 'PATCH', { modelSelection: { instanceId: 'copilot', model: 'fixture-gpt', effort: 'high' } });
    await control(['send', '--bot', bot.id, '--task', bot.activeTaskId, '--text', 'COPILOTBOT_FIXTURE']);
    await expect.poll(async () => {
      const history = await control(['messages', '--bot', bot.id, '--task', bot.activeTaskId, '--limit', '20']) as { messages: Array<{ text?: string }> };
      return history.messages.some(m => m.text === 'NATIVE_EFFORT_OK:fixture-gpt:high');
    }, { timeout: 10000 }).toBe(true);
    const configured = await request('/api/config', 'PUT', { azure: { endpoint: 'https://fixture.openai.azure.com', auth: 'api-key', key: 'fixture-secret', models: ['chat'], ttsDeployment: 'tts', realtimeDeployment: 'live', transcriptionDeployment: 'transcribe' }, live: { provider: 'azure' } });
    expect(configured.azure.configured).toBe(true);
    expect(configured.live).toMatchObject({ provider: 'azure', configured: true });
    expect(JSON.stringify(configured)).not.toContain('fixture-secret');
    const disk = JSON.parse(readFileSync(join(fixture.info.dataDir, 'config.json'), 'utf8'));
    expect(disk.azure.models).toEqual(['chat']);
  } finally { await fixture.close(); }
}, 60000);
