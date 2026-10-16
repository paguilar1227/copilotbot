import { execCli } from '../procs.ts';
import { augmentedPath } from '../env-path.ts';
import type { AzureConfig } from '../../shared/copilotbot.ts';
import type { DeviceSignIn } from '../drivers/device-auth.ts';

export type AzureRunner = (args: string[]) => Promise<string>;
export function azureEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: augmentedPath(), ...overrides };
}

export function azureRunner(overrides: NodeJS.ProcessEnv = {}): AzureRunner {
  const environment = azureEnvironment(overrides);
  return args => new Promise((resolve, reject) => {
  execCli('az', args, { env: { ...environment, PATH: environment.PATH || augmentedPath() }, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(new Error((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'Azure CLI was not found. Install it, then choose Sign in with Microsoft.'
      : 'Azure CLI could not complete the request. Sign in again and check your tenant, subscription and Azure permissions.'));
    else resolve(stdout);
  });
  });
}
export const runAzure = azureRunner();

export function azureCredential(config: AzureConfig, runner: AzureRunner = runAzure) {
  const cached = new Map<string, { token: string; expires: number }>();
  const pending = new Map<string, Promise<string>>();
  const token = async (scope: string) => {
    const previous = cached.get(scope);
    // Azure tokens must remain valid during the request; renew before the expiry minute.
    if (previous && previous.expires - Date.now() > 60_000) return previous.token;
    if (!pending.has(scope)) pending.set(scope, (async () => {
      const args = ['account', 'get-access-token', '--resource', scope, '--output', 'json'];
      // Azure CLI forbids combining these selectors; a subscription selects its tenant.
      if (config.subscription) args.push('--subscription', config.subscription);
      else if (config.tenant) args.push('--tenant', config.tenant);
      const result = JSON.parse(await runner(args)) as { accessToken?: string; expires_on?: number; expiresOn?: string };
      const expires = result.expires_on ? Number(result.expires_on) * 1000 : Date.parse(result.expiresOn ?? '');
      if (!result.accessToken || !Number.isFinite(expires) || expires <= Date.now()) throw new Error('Azure CLI returned no valid access token. Sign in with Microsoft again.');
      cached.set(scope, { token: result.accessToken, expires });
      return result.accessToken;
    })().finally(() => pending.delete(scope)));
    return pending.get(scope)!;
  };
  return {
    async headers(realtime = false): Promise<Record<string, string>> {
      if (config.auth === 'api-key') {
        if (!config.key?.trim()) throw new Error('Save an Azure Foundry API key in Settings → API keys.');
        return { 'api-key': config.key.trim() };
      }
      return { authorization: `Bearer ${await token(realtime ? 'https://ai.azure.com' : 'https://cognitiveservices.azure.com')}` };
    },
  };
}

export function azureDeviceSignIn(config: AzureConfig, runner?: AzureRunner): DeviceSignIn {
  return {
    provider: 'azure', product: 'Azure CLI', account: 'Microsoft', homeEnv: 'AZURE_CONFIG_DIR', homeDir: '.azure',
    loginArgs: ['login', '--use-device-code', '--output', 'none', ...(config.tenant ? ['--tenant', config.tenant] : [])],
    install: 'Install Azure CLI, then choose Sign in with Microsoft.',
    failure: () => 'Microsoft sign-in did not finish. Check your connection and tenant, then try again.',
    signedIn: async env => { try { await azureCredential(config, runner ?? azureRunner(env)).headers(); return true; } catch { return false; } },
  };
}

export interface AzureDeployment { name: string; model: string; type: 'chat' | 'live' | 'realtime' | 'tts' | 'transcription' | 'other' }
export function deploymentType(model: string): AzureDeployment['type'] {
  if (/tts|text-to-speech/i.test(model)) return 'tts';
  if (/transcribe|whisper|realtime-translate/i.test(model)) return 'transcription';
  if (/^gpt-live-\d/i.test(model)) return 'live';
  if (/realtime/i.test(model)) return 'realtime';
  if (/embedding|image|flux|sora|dall-e|speech|audio/i.test(model)) return 'other';
  return 'chat';
}
export async function azureDeployments(config: AzureConfig, runner: AzureRunner = runAzure): Promise<AzureDeployment[]> {
  if (!config.resourceGroup || !config.resourceName) return (config.models ?? []).map(name => ({ name, model: name, type: deploymentType(name) }));
  const args = ['cognitiveservices', 'account', 'deployment', 'list', '--resource-group', config.resourceGroup, '--name', config.resourceName, '--output', 'json'];
  if (config.subscription) args.push('--subscription', config.subscription);
  const rows = JSON.parse(await runner(args)) as Array<{ name: string; properties?: { model?: { name?: string }; provisioningState?: string } }>;
  return rows.filter(row => row.properties?.provisioningState === 'Succeeded').map(row => {
    const model = row.properties?.model?.name ?? row.name;
    return { name: row.name, model, type: deploymentType(model) };
  });
}
