import { azureEndpoint, type AzureConfig } from '../../shared/copilotbot.ts';
import { azureCredential } from './azure-auth.ts';
import { liveInitialInput, liveInstructions, liveVoice, LiveSessionError, MAX_SDP_BYTES, type LiveBot, type LiveHistoryMessage } from '../live-call.ts';
import type { LiveSocket } from '../live-call-controller.ts';
import { openAzureSocket, type AzureSocketFactory } from './azure-socket.ts';

/** GPT-Live uses the controller's native event protocol, separately from Azure Realtime. */
export async function createAzureGptLiveSession(input: {
  config: AzureConfig; sdp: string; bot: LiveBot; history: LiveHistoryMessage[]; voice: string;
  fetchImpl?: typeof fetch; socketFactory?: AzureSocketFactory;
}): Promise<{ sessionId: string; sdp: string; openSocket: () => LiveSocket }> {
  const { config } = input;
  if (!config.endpoint || !config.liveDeployment) throw new LiveSessionError('Set the Azure Foundry endpoint and GPT-Live deployment in Settings → API keys.', 409);
  if (!input.sdp.trim() || Buffer.byteLength(input.sdp) > MAX_SDP_BYTES) throw new LiveSessionError('The audio offer is not valid.', 400);
  const endpoint = azureEndpoint(config.endpoint);
  const headers = await azureCredential(config).headers(true);
  const history = liveInitialInput(input.history);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${endpoint}/openai/v1/live/sessions`, {
      method: 'POST', redirect: 'error', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        session: {
          model: config.liveDeployment,
          instructions: liveInstructions(input.bot),
          delegation: { type: 'client' },
          audio: { output: { voice: liveVoice(input.voice) } },
          ...(history.length ? { input: history } : {}),
        },
        transport: { type: 'webrtc', sdp: input.sdp },
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new LiveSessionError('Could not reach Azure GPT-Live. Check the connection and try again.', 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new LiveSessionError(`Azure GPT-Live session failed (HTTP ${response.status}). Check the deployment, voice and Azure permissions.`, response.status === 429 ? 429 : 502);
  }
  const result = await response.json().catch(() => null) as { session?: { id?: unknown }; transport?: { sdp?: unknown } } | null;
  const sessionId = result?.session?.id;
  const sdp = result?.transport?.sdp;
  if (typeof sessionId !== 'string' || !sessionId.trim() || typeof sdp !== 'string' || !sdp.trim()) {
    throw new LiveSessionError('Azure returned an invalid GPT-Live connection.', 502);
  }
  const attach = `${endpoint.replace(/^https:/, 'wss:')}/openai/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`;
  const factory = input.socketFactory ?? openAzureSocket;
  return { sessionId, sdp, openSocket: () => Object.assign(factory(attach, headers), { requiresCloseConfirmation: true }) };
}
