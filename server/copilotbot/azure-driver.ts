import type { ModelCatalog, ProviderDriver } from '../contracts.ts';
import { createOpenAIChatRuntime } from '../drivers/openai-chat.ts';
import { DeviceAuthController } from '../drivers/device-auth.ts';
import { azureConfigSchema, type AzureConfig } from '../../shared/copilotbot.ts';
import { azureCredential, azureDeployments, azureDeviceSignIn, azureRunner, azureEnvironment } from './azure-auth.ts';

const empty: ModelCatalog = { default: '', options: [] };
export const AzureFoundryDriver: ProviderDriver<AzureConfig> = {
  driverKind: 'azureFoundry',
  metadata: { displayName: 'Azure Foundry', access: 'api', supportsMultipleInstances: true },
  models: empty,
  install: { settings: 'connections', docsUrl: 'https://learn.microsoft.com/azure/foundry/openai/how-to/managed-identity', signInCommand: 'az login --use-device-code' },
  decodeConfig: raw => azureConfigSchema.parse(raw ?? {}),
  defaultConfig: () => ({}),
  async create(input) {
    const config = { ...input.config, key: input.environment.COPILOTBOT_AZURE_KEY ?? input.config.key };
    const runner = azureRunner(input.environment);
    const credential = azureCredential(config, runner);
    let catalog = empty;
    let discoveryError: string | undefined;
    const refresh = async () => {
      try {
        const deployments = await azureDeployments(config, runner);
        const names = [...new Set([...(config.models ?? []), ...deployments.filter(d => d.type === 'chat').map(d => d.name)])];
        catalog = { default: names[0] ?? '', options: names.map(id => ({ id, label: id })) };
        discoveryError = undefined;
      } catch (error) { discoveryError = (error as Error).message; }
    };
    await refresh();
    const auth = new DeviceAuthController(azureDeviceSignIn(config, runner), {
      cli: 'az', environment: () => azureEnvironment(input.environment), onAuthenticated: refresh,
    });
    const instance = createOpenAIChatRuntime({
      input, driverKind: 'azureFoundry', apiKey: config.auth === 'api-key' ? config.key ?? '' : '',
      apiUrl: `${config.endpoint ?? ''}/openai/v1`,
      headers: () => credential.headers(),
      models: () => catalog, refreshModels: refresh,
      requestBody: (model, messages, stream, effort) => ({ model, messages, stream, ...(stream ? { stream_options: { include_usage: true } } : {}), ...(effort ? { reasoning_effort: effort } : {}) }),
      httpErrorLabel: 'Azure Foundry', missingKeyError: 'Configure Azure Foundry in Settings → API keys.',
      unavailableReason: 'Configure Azure Foundry in Settings → API keys.', timeoutMs: 180_000,
      reasoning: true, billing: 'metered', tools: true, computerUse: true, includeUsageInCompleted: true,
      effortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
      nativeLog: { source: 'azure.chat.completions', outgoing: (_turn, messages, model, tools) => ({ model, messageCount: messages.length, tools: tools.map(t => t.function.name) }), incoming: result => ({ textLength: result.text.length, usage: result.usage }) },
    });
    const dispose = instance.dispose;
    return {
      ...instance,
      get models() { return catalog; },
      async snapshot() {
        if (!config.endpoint) return { state: 'unavailable' as const, reason: 'Set your Azure Foundry endpoint in Settings → API keys.' };
        try {
          await credential.headers();
          return { state: 'available' as const, authenticated: true, ...(discoveryError ? { reason: discoveryError } : {}), billing: 'metered' as const };
        } catch (error) { return { state: 'available' as const, authenticated: false, reason: (error as Error).message }; }
      },
      startAuthentication: () => auth.start(), getAuthentication: id => auth.get(id), cancelAuthentication: () => auth.cancel(),
      dispose: async () => { await auth.dispose(); await dispose?.(); },
    };
  },
};
