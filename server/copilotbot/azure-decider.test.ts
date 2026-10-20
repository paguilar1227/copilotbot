import { describe, expect, it, vi } from 'vitest';
import { createDecider, deciderSavePatch, describeDecider } from '../decider/index.ts';
import { decideRoomResponder } from '../decider/room-routing.ts';
import type { AppConfig } from '../config.ts';

const azure = { endpoint: 'https://example.openai.azure.com', auth: 'api-key' as const, key: 'fixture-private-key' };
const config: AppConfig = { azure, decider: { provider: 'azure', azureDeployment: 'fast-decisions', enabled: true } };
const question = { instructions: 'Who answers?', options: { research: 'Researcher', code: 'Coder' } };
const reply = (content = JSON.stringify({ answers: { answer: { choice: 'code', probabilities: { research: 0.1, code: 0.9 } } } })) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 22 } }));

describe('Azure Foundry decisions', () => {
  it('uses the selected deployment and Azure key with strict JSON, without OpenRouter fields', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply());
    const decider = createDecider({ config: () => config, fetch: fetcher });
    expect(await decider.choose('roomRouting', { message: 'fix build' }, question)).toMatchObject({ ok: true, provider: 'azure', answers: { choice: 'code' }, inputTokens: 22 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${azure.endpoint}/openai/v1/chat/completions`);
    expect(init?.headers).toMatchObject({ 'api-key': azure.key });
    expect(init?.redirect).toBe('error');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('fast-decisions');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.provider).toBeUndefined(); expect(body.max_tokens).toBeUndefined();
    expect(JSON.stringify(describeDecider(config))).not.toContain(azure.key);
  });

  it('shares Entra auth, refreshes tokens through the existing Azure helper, and needs no API key', async () => {
    const cfg: AppConfig = { ...config, azure: { endpoint: azure.endpoint, auth: 'entra', subscription: 'fixture-subscription' } };
    const runner = vi.fn(async () => JSON.stringify({ accessToken: 'fixture-entra-token', expires_on: Date.now() / 1000 + 3600 }));
    const fetcher = vi.fn<typeof fetch>(async () => reply(JSON.stringify({ answers: { answer: { noul: 1 } } })));
    const decider = createDecider({ config: () => cfg, azureRunner: runner, fetch: fetcher });
    expect(await decider.testKey()).toMatchObject({ ok: true, provider: 'azure' });
    expect(await decider.testKey()).toMatchObject({ ok: true });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]).toEqual([['account', 'get-access-token', '--resource', 'https://cognitiveservices.azure.com', '--output', 'json', '--subscription', 'fixture-subscription']]);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer fixture-entra-token' });
  });

  it.each([401, 403, 429, 503])('fails safely on HTTP %s without exposing provider response bodies', async status => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('provider-secret-echo', { status }));
    const result = await createDecider({ config: () => config, fetch: fetcher }).choose('roomRouting', {}, question);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('provider-secret-echo');
  });

  it('rejects malformed answers and keeps room lead fallback', async () => {
    const decider = createDecider({ config: () => config, fetch: vi.fn(async () => reply('not-json')) });
    const result = await decideRoomResponder(decider, { room: 'Team', humans: [], members: [{ id: 'code', name: 'Code', title: '', description: '' }, { id: 'research', name: 'Research', title: '', description: '' }], recent: [], message: { from: 'User', text: 'hi' } });
    expect(result).toMatchObject({ kind: 'fallback', reason: 'malformed' });
  });

  it('requires connection and deployment before enabling and preserves opt-out', () => {
    expect(deciderSavePatch({ provider: 'azure', enabled: true }, undefined)).toMatchObject({ ok: false });
    expect(deciderSavePatch({ provider: 'azure', enabled: true, azureDeployment: 'fast-decisions' }, undefined, false, azure)).toMatchObject({ ok: true });
    expect(deciderSavePatch({ azureDeployment: 'another' }, { provider: 'azure', enabled: false }, false, azure)).toEqual({ ok: true, patch: { azureDeployment: 'another' } });
  });

  it('never sends an Azure credential to an invalid endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply());
    const cfg = { ...config, azure: { ...azure, endpoint: 'https://untrusted.example' } };
    expect(await createDecider({ config: () => cfg, fetch: fetcher }).testKey()).toMatchObject({ ok: false, reason: 'misconfigured' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
