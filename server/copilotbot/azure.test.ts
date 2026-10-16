import { describe, it, expect, vi } from 'vitest';
import { azureConfigSchema, azureSettings } from '../../shared/copilotbot.ts';
import { azureCredential, azureDeployments } from './azure-auth.ts';
import { azureSpeech } from './azure-tts.ts';
import { AzureLiveSocket, createAzureLiveSession } from './azure-live.ts';
import { LiveCallController, type LiveSocket, type LiveCallDeps } from '../live-call-controller.ts';
import { liveInstructions } from '../live-call.ts';
import { deviceSignInPrompt, deviceSignInLink } from '../../shared/device-sign-in.ts';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { azureRunner, azureDeviceSignIn } from './azure-auth.ts';
import { DeviceAuthController } from '../drivers/device-auth.ts';

const endpoint = 'https://test.openai.azure.com';
class Socket implements LiveSocket {
  readyState = 1;
  onopen: LiveSocket['onopen'] = null;
  onmessage: LiveSocket['onmessage'] = null;
  onclose: LiveSocket['onclose'] = null;
  onerror: LiveSocket['onerror'] = null;
  sent: Record<string, any>[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.({}); }
  emit(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

describe('Azure authentication and deployment setup', () => {
  it('rejects foreign credential destinations and exposes no key', () => {
    for (const url of ['https://evil.test', 'http://test.openai.azure.com', `${endpoint}/?api-key=secret`, 'https://test.openai.azure.com@evil.test']) {
      expect(azureConfigSchema.safeParse({ endpoint: url }).success).toBe(false);
    }
    expect(azureSettings({ endpoint, auth: 'api-key', key: 'private' })).toEqual({ endpoint, auth: 'api-key', configured: true });
  });
  it('coalesces token refresh, uses the correct audiences and never needs a key for Entra', async () => {
    const runner = vi.fn(async (_args: string[]) => JSON.stringify({ accessToken: 'test-token', expires_on: Date.now() / 1000 + 3600 }));
    const auth = azureCredential({ tenant: 'tenant', subscription: 'subscription' }, runner);
    expect(await Promise.all([auth.headers(), auth.headers()])).toEqual([{ authorization: 'Bearer test-token' }, { authorization: 'Bearer test-token' }]);
    await auth.headers();
    expect(runner).toHaveBeenCalledTimes(1);
    await auth.headers(true);
    expect(runner.mock.calls[0]?.[0]).toContain('https://cognitiveservices.azure.com');
    expect(runner.mock.calls[1]?.[0]).toContain('https://ai.azure.com');
    expect(await azureCredential({ auth: 'api-key', key: 'key' }, runner).headers()).toEqual({ 'api-key': 'key' });
    expect(runner).toHaveBeenCalledTimes(2);
  });
  it('separates chat, TTS and transcription-only deployments from conversational Realtime', async () => {
    const deployments = await azureDeployments({ resourceGroup: 'rg', resourceName: 'ai' }, async () => JSON.stringify(
      ['gpt-5.4', 'gpt-realtime', 'gpt-realtime-whisper', 'gpt-4o-mini-tts'].map(name => ({ name, properties: { model: { name }, provisioningState: 'Succeeded' } })),
    ));
    expect(deployments.map(d => d.type)).toEqual(['chat', 'realtime', 'transcription', 'tts']);
  });
  it('keeps login and token confirmation in the same instance credential directory', async () => {
    const bin = join(homedir(), 'azure-bin');
    mkdirSync(bin);
    const trace = join(homedir(), 'azure-trace.jsonl');
    writeFileSync(join(bin, 'az'), `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(process.env.AZURE_TRACE, JSON.stringify({args:process.argv.slice(2),directory:process.env.AZURE_CONFIG_DIR})+'\\n');
if(process.argv[2]==='login') { console.error('Open https://microsoft.com/devicelogin and enter ABCD12345'); }
else { console.log(JSON.stringify({accessToken:'fixture-token',expires_on:Date.now()/1000+3600})); }
`, { mode: 0o700 });
    const env = { ...process.env, PATH: bin + delimiter + process.env.PATH, AZURE_CONFIG_DIR: join(homedir(), 'instance-account'), AZURE_TRACE: trace };
    const auth = new DeviceAuthController(azureDeviceSignIn({}, azureRunner(env)), { cli: 'az', environment: () => env });
    try {
      const flow = await auth.start();
      await expect.poll(() => auth.get(flow.flowId!), { timeout: 5000 }).toMatchObject({ phase: 'succeeded' });
      const rows = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows.map(row => row.args[0])).toEqual(['login', 'account']);
      expect(rows.every(row => row.directory === join(homedir(), 'instance-account'))).toBe(true);
    } finally { await auth.dispose(); }
  });
  it('refreshes an expiring Entra token', async () => {
    vi.useFakeTimers();
    try {
      const runner = vi.fn(async () => JSON.stringify({ accessToken: `token-${Date.now()}`, expires_on: Date.now() / 1000 + 120 }));
      const auth = azureCredential({}, runner);
      const first = await auth.headers();
      vi.setSystemTime(Date.now() + 65_000);
      expect(await auth.headers()).not.toEqual(first);
      expect(runner).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it.each([
    [{ tenant: 'tenant', subscription: 'subscription' }, ['--subscription', 'subscription']],
    [{ tenant: 'tenant' }, ['--tenant', 'tenant']],
    [{ subscription: 'subscription' }, ['--subscription', 'subscription']],
    [{}, []],
  ])('selects one Azure CLI account context for %j', async (config, selection) => {
    const runner = vi.fn(async (args: string[]) => {
      if (args.includes('--tenant') && args.includes('--subscription')) {
        throw new Error('Please specify only one of subscription and tenant, not both');
      }
      return JSON.stringify({ accessToken: 'test-token', expires_on: Date.now() / 1000 + 3600 });
    });
    const credential = azureCredential(config, runner);
    await credential.headers();
    await credential.headers(true);
    expect(runner.mock.calls.map(([args]) => args)).toEqual([
      ['account', 'get-access-token', '--resource', 'https://cognitiveservices.azure.com', '--output', 'json', ...selection],
      ['account', 'get-access-token', '--resource', 'https://ai.azure.com', '--output', 'json', ...selection],
    ]);
  });
  it('sends the Azure TTS deployment with its key, validates audio and hides remote errors', async () => {
    const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mpeg' } }));
    const audio = await azureSpeech({ endpoint, auth: 'api-key', key: 'secret', ttsDeployment: 'voice-deployment' }, 'hello', 'alloy', request);
    expect(audio.bytes.length).toBe(2);
    expect(request.mock.calls[0]?.[0]).toBe(`${endpoint}/openai/v1/audio/speech`);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).model).toBe('voice-deployment');
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ 'api-key': 'secret' });
    await expect(azureSpeech({ endpoint, auth: 'api-key', key: 'secret', ttsDeployment: 'voice' }, 'hello', 'alloy', async () => new Response('secret', { status: 403 }))).rejects.toThrow('HTTP 403');
  });
});

describe('Live voice and Azure protocol integration', () => {
  it('grounds the live model in its audio input even when history contains old transcript claims', () => {
    expect(liveInstructions({ name: 'Ada' })).toContain('microphone audio directly');
    expect(liveInstructions({ name: 'Ada' })).toContain('task agent receives transcribed requests');
  });
  it('creates a WebRTC call using an ephemeral secret and keeps long-lived credentials server-side', async () => {
    const source = new Socket();
    const factory = vi.fn(() => source);
    const request = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => String(url).endsWith('client_secrets')
      ? Response.json({ value: 'ephemeral' })
      : new Response('v=0\r\n', { status: 201, headers: { location: `${endpoint}/openai/v1/realtime/calls/call1` } }));
    const session = await createAzureLiveSession({ config: { endpoint, auth: 'api-key', key: 'secret', realtimeDeployment: 'live', transcriptionDeployment: 'transcribe' }, sdp: 'offer', bot: { name: 'Ada' }, history: [], voice: 'marin', fetchImpl: request, socketFactory: factory });
    expect(session.sessionId).toBe('call1');
    expect(JSON.stringify({ sessionId: session.sessionId, sdp: session.sdp })).not.toMatch(/secret|ephemeral/);
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ 'api-key': 'secret' });
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: 'Bearer ephemeral' });
    session.openSocket();
    expect(factory).toHaveBeenCalledWith(`${endpoint.replace('https:', 'wss:')}/openai/v1/realtime?call_id=call1`, { 'api-key': 'secret' });
  });
  it('waits for real transcription, delivers the spoken request to the task agent and hangs up', async () => {
    vi.useFakeTimers();
    try {
      const source = new Socket();
      const hangup = vi.fn(async () => {});
      const socket = new AzureLiveSocket(source, hangup, []);
      const send = vi.fn(async () => ({ kind: 'started' as const, messageId: 'message' }));
      const deps: LiveCallDeps = {
        store: { onChange: () => () => {} }, send, respond: async () => ({ ok: true }), queued: () => false,
        activity: () => 'idle', broadcast: () => {}, pro: () => true,
        settings: () => ({ configured: true, key: '', voice: 'marin', readTypedReplies: true, idleMinutes: 5 }),
        createSession: async () => ({ sessionId: 'azure', sdp: 'answer', openSocket: () => socket }),
        openSocket: () => { throw new Error('Legacy transport must not run'); }, attachUrl: () => '', speakable: text => [text], log: () => {},
      };
      const controller = new LiveCallController(deps);
      const { call } = await controller.start({ auth: { kind: 'loopback', scopes: ['admin', 'client'] }, botId: 'b', botName: 'Ada', threadId: 't', client: 'desktop', sdp: 'offer' });
      source.onopen?.({});
      source.emit({ type: 'input_audio_buffer.speech_started', item_id: 'i', audio_start_ms: 1 });
      source.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'i', audio_end_ms: 500 });
      source.emit({ type: 'response.function_call_arguments.done', name: 'delegate_to_agent', call_id: 'tool' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(send).not.toHaveBeenCalled();
      source.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i', transcript: 'Check my calendar' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'Check my calendar', callId: call.callId }));
      expect(source.sent.some(event => event.item?.type === 'function_call_output' && event.item.call_id === 'tool')).toBe(true);
      const end = controller.end(call.callId);
      await vi.runOnlyPendingTimersAsync();
      await end;
      expect(hangup).toHaveBeenCalledTimes(1);
      expect(controller.current()).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('reports refused hangup and cleans up once after sideband loss', async () => {
    const source = new Socket();
    const request = vi.fn(async (url: string | URL | Request) => String(url).endsWith('client_secrets')
      ? Response.json({ value: 'temporary' })
      : String(url).endsWith('hangup') ? new Response('', { status: 403 })
      : new Response('answer', { status: 201, headers: { location: `${endpoint}/openai/v1/realtime/calls/call` } }));
    const session = await createAzureLiveSession({ config: { endpoint, auth: 'api-key', key: 'secret', realtimeDeployment: 'live', transcriptionDeployment: 'transcribe' }, sdp: 'offer', voice: 'marin', bot: { name: 'Ada' }, history: [], fetchImpl: request, socketFactory: () => source });
    const socket = session.openSocket();
    const events: Record<string, any>[] = [];
    socket.onmessage = event => events.push(JSON.parse(String(event.data)));
    socket.send(JSON.stringify({ type: 'session.close' }));
    await expect.poll(() => events.some(event => event.error?.code === 'azure-hangup-failed')).toBe(true);
    expect(request.mock.calls.filter(call => String(call[0]).endsWith('hangup'))).toHaveLength(1);
  });
});

it('accepts only official device code pages and parses actual CLI wording', () => {
  expect(deviceSignInPrompt('copilot', 'First copy your one-time code: ABCD-EFGH\nOpen https://github.com/login/device in your browser\n')).toEqual({ authorizationUrl: 'https://github.com/login/device', userCode: 'ABCD-EFGH' });
  expect(deviceSignInPrompt('azure', 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD12345 to authenticate.\n')).toEqual({ authorizationUrl: 'https://microsoft.com/devicelogin', userCode: 'ABCD12345' });
  expect(deviceSignInLink('copilot', 'https://github.com/login/device?token=secret')).toBeNull();
});
