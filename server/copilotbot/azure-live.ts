import { azureEndpoint, type AzureConfig } from '../../shared/copilotbot.ts';
import { azureCredential } from './azure-auth.ts';
import { liveInstructions, liveInitialInput, LiveSessionError, MAX_SDP_BYTES, type LiveBot, type LiveHistoryMessage } from '../live-call.ts';
import type { LiveSocket } from '../live-call-controller.ts';

type Event = Record<string, any>;
export type AzureSocketFactory = (url: string, headers: Record<string, string>) => LiveSocket;

/** Azure Realtime's function calls and audio transcription mapped to the Live controller contract. */
export class AzureLiveSocket implements LiveSocket {
  readonly requiresCloseConfirmation = true;
  onopen: LiveSocket['onopen'] = null;
  onmessage: LiveSocket['onmessage'] = null;
  onclose: LiveSocket['onclose'] = null;
  onerror: LiveSocket['onerror'] = null;
  private source: LiveSocket;
  private hangup: () => Promise<void>;
  private pendingSpeech = new Set<string>();
  private speechTimes = new Map<string, { start: number; end: number }>();
  private waitingTools: Event[] = [];
  private answered = new Set<string>();
  private activeResponse = false;
  private responsePending = false;
  private latestEnd = 0;
  private started = Date.now();
  private closed = false;
  private ending = false;
  private remoteStop: Promise<void> | null = null;

  constructor(source: LiveSocket, hangup: () => Promise<void>, history: LiveHistoryMessage[]) {
    this.source = source;
    this.hangup = hangup;
    source.onopen = event => {
      for (const item of liveInitialInput(history)) this.write({ type: 'conversation.item.create', item });
      this.onopen?.(event);
    };
    source.onmessage = event => {
      let value: Event;
      try { value = JSON.parse(String(event.data)); } catch { return; }
      this.receive(value);
    };
    source.onerror = event => this.onerror?.(event);
    source.onclose = event => { void this.stopRemote(); this.closed = true; this.onclose?.(event); };
  }
  get readyState() { return this.source.readyState; }
  close(code?: number, reason?: string) {
    void this.stopRemote();
    this.closed = true;
    this.source.close(code, reason);
  }
  private stopRemote() {
    this.remoteStop ??= this.hangup().catch(() => { this.emit({ type: 'error', error: { code: 'azure-hangup-failed' } }); });
    return this.remoteStop;
  }
  private emit(event: Event) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(event) }); }
  private write(event: Event) { if (!this.closed) this.source.send(JSON.stringify(event)); }
  private respond() {
    if (this.activeResponse) { this.responsePending = true; return; }
    this.activeResponse = true;
    this.responsePending = false;
    this.write({ type: 'response.create' });
  }
  private deliverTools() {
    if (this.pendingSpeech.size) return;
    for (const tool of this.waitingTools.splice(0)) {
      this.emit({ type: 'session.delegation.created', delegation: { id: tool.call_id, target: 'client' }, offset_ms: this.latestEnd });
    }
  }
  private receive(event: Event) {
    switch (event.type) {
      case 'session.created': this.emit({ type: 'session.started' }); break;
      case 'input_audio_buffer.speech_started':
        this.pendingSpeech.add(event.item_id);
        this.speechTimes.set(event.item_id, { start: event.audio_start_ms, end: event.audio_start_ms });
        break;
      case 'input_audio_buffer.speech_stopped': {
        const times = this.speechTimes.get(event.item_id);
        if (times) times.end = event.audio_end_ms;
        this.latestEnd = Math.max(this.latestEnd, event.audio_end_ms || 0);
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const times = this.speechTimes.get(event.item_id) ?? { start: this.latestEnd + 1, end: Date.now() - this.started };
        this.latestEnd = Math.max(this.latestEnd, times.end);
        this.emit({ type: 'session.input_transcript.delta', delta: `${event.transcript} `, start_ms: times.start, end_ms: times.end });
        this.pendingSpeech.delete(event.item_id);
        this.speechTimes.delete(event.item_id);
        this.deliverTools();
        break;
      }
      case 'response.function_call_arguments.done':
        if (event.name !== 'delegate_to_agent') break;
        this.waitingTools.push(event);
        this.deliverTools();
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        this.emit({ type: 'session.output_transcript.delta', delta: event.delta });
        break;
      case 'response.created': this.activeResponse = true; break;
      case 'response.done':
        this.activeResponse = false;
        if (this.responsePending) this.respond();
        break;
      case 'conversation.item.input_audio_transcription.failed':
        this.emit({ type: 'error', error: { code: 'azure-transcription-failed' } });
        void this.end();
        break;
      case 'error': this.emit({ type: 'error', error: { code: String(event.error?.code ?? 'azure-realtime') } }); break;
    }
  }
  send(data: string) {
    const event = JSON.parse(data) as Event;
    if (event.type === 'session.close') { void this.end(); return; }
    if (!/^session\.(instructions|thinking|commentary)\.append$/.test(event.type)) return;
    const id = event.delegation_id;
    if (id && !this.answered.has(id)) {
      this.answered.add(id);
      this.write({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: id, output: event.content } });
    } else {
      this.write({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: event.content }] } });
    }
    this.respond();
  }
  private async end() {
    if (this.closed || this.ending) return;
    this.ending = true;
    try { await this.stopRemote(); }
    finally {
      this.emit({ type: 'session.closed', usage: { seconds: (Date.now() - this.started) / 1000 } });
      this.close(1000, 'call ended');
    }
  }
}

export async function createAzureLiveSession(input: {
  config: AzureConfig; sdp: string; bot: LiveBot; history: LiveHistoryMessage[]; voice: string;
  fetchImpl?: typeof fetch; socketFactory?: AzureSocketFactory;
}): Promise<{ sessionId: string; sdp: string; openSocket: () => LiveSocket }> {
  const { config } = input;
  if (!config.endpoint || !config.realtimeDeployment || !config.transcriptionDeployment) {
    throw new LiveSessionError('Set the Azure Foundry endpoint, Realtime deployment and transcription deployment in Settings → API keys.', 409);
  }
  if (!input.sdp.trim() || Buffer.byteLength(input.sdp) > MAX_SDP_BYTES) throw new LiveSessionError('The audio offer is not valid.', 400);
  const endpoint = azureEndpoint(config.endpoint);
  const createSignal = AbortSignal.timeout(20_000);
  const credential = azureCredential(config);
  const headers = await credential.headers(true);
  const request = input.fetchImpl ?? fetch;
  const session = {
    type: 'realtime', model: config.realtimeDeployment,
    instructions: `${liveInstructions(input.bot)}\nYou hear live microphone audio. Use delegate_to_agent for work or facts that need checking. Wait for its updates and speak them naturally. Never claim that you only receive text.`,
    audio: { input: { transcription: { model: config.transcriptionDeployment }, turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true } }, output: { voice: input.voice } },
    tools: [{ type: 'function', name: 'delegate_to_agent', description: 'Ask your task agent to act on the current spoken request. Its results arrive as updates.', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
    tool_choice: 'auto',
  };
  const secretResponse = await request(`${endpoint}/openai/v1/realtime/client_secrets`, {
    method: 'POST', redirect: 'error', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ session }), signal: createSignal,
  });
  if (!secretResponse.ok) { await secretResponse.body?.cancel(); throw new LiveSessionError(`Azure Realtime session failed (HTTP ${secretResponse.status}). Check the deployment and Azure permissions.`, 502); }
  const secret = await secretResponse.json() as { value?: string };
  if (!secret.value) throw new LiveSessionError('Azure returned no Realtime client secret.', 502);
  const response = await request(`${endpoint}/openai/v1/realtime/calls`, {
    method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${secret.value}`, 'content-type': 'application/sdp' }, body: input.sdp, signal: createSignal,
  });
  if (!response.ok) { await response.body?.cancel(); throw new LiveSessionError(`Azure Realtime audio connection failed (HTTP ${response.status}).`, 502); }
  const sdp = await response.text();
  const location = response.headers.get('location');
  const url = location ? new URL(location, endpoint) : null;
  if (!sdp.trim() || !url || url.origin !== endpoint || !/^\/openai\/v1\/realtime\/calls\/[^/]+$/.test(url.pathname)) {
    throw new LiveSessionError('Azure returned an invalid Realtime connection.', 502);
  }
  const sessionId = url.pathname.split('/').at(-1)!;
  const attach = `${endpoint.replace(/^https:/, 'wss:')}/openai/v1/realtime?call_id=${encodeURIComponent(sessionId)}`;
  const factory: AzureSocketFactory = input.socketFactory ?? ((address, auth) => new WebSocket(address, { headers: auth } as unknown as string[]) as unknown as LiveSocket);
  return { sessionId, sdp, openSocket: () => new AzureLiveSocket(factory(attach, headers), async () => {
    const result = await request(`${url.href}/hangup`, { method: 'POST', redirect: 'error', headers: await credential.headers(true), signal: AbortSignal.timeout(5_000) });
    await result.body?.cancel();
    if (!result.ok && result.status !== 404) throw new Error(`Azure did not confirm hangup (HTTP ${result.status}).`);
  }, input.history) };
}
