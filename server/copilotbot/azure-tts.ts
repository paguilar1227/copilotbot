import { AZURE_VOICES, azureEndpoint, type AzureConfig } from '../../shared/copilotbot.ts';
import { azureCredential } from './azure-auth.ts';
import type { Audio, Voice } from '../tts/elevenlabs.ts';

export const azureVoices = (): Voice[] => AZURE_VOICES.map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }));
export async function azureSpeech(config: AzureConfig, text: string, voice: string, fetchImpl = fetch): Promise<Audio> {
  if (!config.endpoint || !config.ttsDeployment) throw new Error('Set an Azure Foundry endpoint and TTS deployment in Settings → API keys.');
  const headers = await azureCredential(config).headers();
  const response = await fetchImpl(`${azureEndpoint(config.endpoint)}/openai/v1/audio/speech`, {
    method: 'POST', redirect: 'error', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.ttsDeployment, input: text, voice, response_format: 'mp3' }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Azure speech failed (HTTP ${response.status}). Check the deployment, credentials and speech permissions.`);
  }
  if (!/audio\/(mpeg|mp3)/.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new Error('Azure returned an unexpected speech format.');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error('Azure returned empty speech.');
  return { bytes, mime: 'audio/mpeg' };
}
