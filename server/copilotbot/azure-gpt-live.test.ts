import { describe, expect, it, vi } from 'vitest';
import { createAzureGptLiveSession } from './azure-gpt-live.ts';
import { deploymentType } from './azure-auth.ts';
import { liveSettingsFor } from '../config.ts';
import type { LiveSocket } from '../live-call-controller.ts';

const endpoint = 'https://test.cognitiveservices.azure.com';
const config = { endpoint, auth: 'api-key' as const, key: 'private-key', liveDeployment: 'my-live' };
const input = { config, sdp: 'offer', bot: { name: 'Ada' }, history: [{ role: 'user' as const, text: 'Hello' }], voice: 'marin' };

describe('Azure GPT-Live', () => {
  it('discovers GPT-Live separately and enables calls without a transcription deployment', () => {
    expect(deploymentType('gpt-live-1')).toBe('live');
    expect(deploymentType('gpt-live-transcribe')).toBe('transcription');
    expect(liveSettingsFor({ azure: config, live: { provider: 'azure' } }).configured).toBe(true);
    expect(liveSettingsFor({ azure: { endpoint }, live: { provider: 'azure' } }).configured).toBe(false);
  });
  it('uses native WebRTC and sideband events, preserving history and keeping credentials on the server', async () => {
    const socket: LiveSocket = { readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null, send: vi.fn(), close: vi.fn() };
    const factory = vi.fn(() => socket);
    const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ session: { id: 'session/1' }, transport: { sdp: 'answer' } }));
    const session = await createAzureGptLiveSession({ ...input, fetchImpl: request, socketFactory: factory });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(`${endpoint}/openai/v1/live/sessions`);
    expect(init?.headers).toMatchObject({ 'api-key': 'private-key' });
    expect(init?.redirect).toBe('error');
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({ session: { model: 'my-live', delegation: { type: 'client' }, audio: { output: { voice: 'marin' } }, input: [{ role: 'user' }] }, transport: { type: 'webrtc', sdp: 'offer' } });
    // Azure rejects the OpenAI-only session.client parameter before creating a call.
    expect(body.session).not.toHaveProperty('client');
    expect(body.session.instructions).toContain('microphone audio directly');
    expect(session.sdp).toBe('answer');
    expect(JSON.stringify(session)).not.toContain('private-key');
    expect(session.openSocket()).toBe(socket);
    expect(socket.requiresCloseConfirmation).toBe(true);
    expect(factory).toHaveBeenCalledWith(`${endpoint.replace('https:', 'wss:')}/openai/v1/live/sessions/session%2F1/attach`, { 'api-key': 'private-key' });
    socket.send(JSON.stringify({ type: 'session.close' }));
    expect(socket.send).toHaveBeenCalledWith('{"type":"session.close"}');
  });
  it('rejects invalid offers before requesting a session', async () => {
    const request = vi.fn();
    await expect(createAzureGptLiveSession({ ...input, sdp: '', fetchImpl: request })).rejects.toThrow('offer');
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects invalid responses and redacts upstream failures', async () => {
    await expect(createAzureGptLiveSession({ ...input, fetchImpl: async () => Response.json({ session: {}, transport: {} }) })).rejects.toThrow('invalid GPT-Live connection');
    await expect(createAzureGptLiveSession({ ...input, fetchImpl: async () => new Response('private-key', { status: 403 }) })).rejects.toThrow('HTTP 403');
  });
});
