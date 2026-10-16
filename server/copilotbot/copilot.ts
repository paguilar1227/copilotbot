import { execCli, spawnCli, killCliTree } from '../procs.ts';
import { createAcpDriver, type AcpConfig, type AcpSupport } from '../drivers/acp/core.ts';
import type { EffortLevel, ModelCatalog, ProviderDriver, ProviderSnapshot, SendTurnInput } from '../contracts.ts';
import { discoverCopilot, type CopilotCatalog } from './copilot-catalog.mjs';
import type { DeviceSignIn } from '../drivers/device-auth.ts';

const signIn: DeviceSignIn = {
  provider: 'copilot', product: 'GitHub Copilot CLI', account: 'GitHub Copilot',
  homeEnv: 'COPILOT_HOME', homeDir: '.copilot', loginArgs: ['login', '--device-code'],
  install: 'Install GitHub Copilot CLI, then choose Set up Copilot again.',
  failure: () => 'Copilot sign-in did not finish. Check your connection and Copilot subscription, then try again.',
};
const models: ModelCatalog = { default: 'agent-default', options: [{ id: 'agent-default', label: 'Copilot CLI default' }] };

export function copilotSupport(discover = discoverCopilot): AcpSupport & { prepare(turn: SendTurnInput): Promise<SendTurnInput> } {
  let catalog: CopilotCatalog | undefined;
  let pending: ReturnType<typeof discoverCopilot> | undefined;
  let environment: Record<string, string | undefined> = {};
  let command = 'copilot';
  let lastResult: Awaited<ReturnType<typeof discoverCopilot>> | undefined;
  const load = (env: Record<string, string | undefined>, cli: string, refresh = false) => {
    environment = env;
    command = cli;
    if (lastResult && !refresh) return Promise.resolve(lastResult);
    if (!pending) pending = discover({ cli, env, spawn: spawnCli, kill: killCliTree })
      .then(result => { catalog = result.catalog; lastResult = result; return result; })
      .finally(() => { pending = undefined; });
    return pending;
  };
  const nativeModel = (model?: string) => model?.replace(/^copilot\//, '') === 'agent-default' || !model ? catalog?.default : model.replace(/^copilot\//, '');
  const check = (model: string | undefined, effort: EffortLevel | undefined) => {
    if (effort && !catalog?.options.find(option => option.id === nativeModel(model))?.variants?.some(variant => variant.id === effort)) {
      throw new Error(`Copilot does not offer ${effort} effort for this model. Choose another effort.`);
    }
  };
  const authenticated = async (env: Record<string, string | undefined>, cli: string) => {
    try { await load(env, cli); return true; } catch { return false; }
  };
  return {
    driverKind: 'copilotAgent', displayName: 'GitHub Copilot', access: 'subscription',
    defaultCli: 'copilot', nativeSource: 'copilot.acp', models,
    effortLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], modelVariants: false,
    spawnArgs: () => ['--acp'], pickAuthMethod: () => null, authFailure: 'continue',
    transformEnv: env => { delete env.COPILOT_GITHUB_TOKEN; delete env.GH_TOKEN; delete env.GITHUB_TOKEN; },
    loginNote: 'Choose Set up Copilot in Settings → Engines to sign in to GitHub.',
    deviceSignIn: { ...signIn, signedIn: async env => { try { await load(env, command, true); return true; } catch { return false; } } },
    install: {
      docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/install-copilot-cli',
      command: { darwin: 'brew install copilot-cli', linux: 'npm install -g @github/copilot', win32: 'winget install GitHub.Copilot' },
      signInCommand: 'copilot login --device-code',
    },
    isAuthenticated: (env, config) => authenticated(env, config.cli),
    selectModel: { configId: 'model' },
    resolveTurnModel: nativeModel,
    async resolveModels(env, config) {
      const result = await load(env, config.cli, true);
      return { default: result.catalog.default, options: result.catalog.options.map(({ id, label }) => ({ id, label })) };
    },
    async prepare(turn) {
      if (pending) await pending;
      if (!catalog) await load(environment, command);
      check(turn.model, turn.effort);
      return { ...turn, model: nativeModel(turn.model) };
    },
    async configureSession({ request, sessionId, turn }) {
      check(turn.model, turn.effort);
      if (!turn.effort) return;
      const result = await request('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: turn.effort });
      const options = result?.configOptions ?? [];
      if (options.find((option: { id: string }) => option.id === 'model')?.currentValue !== nativeModel(turn.model)
        || options.find((option: { id: string }) => option.id === 'reasoning_effort')?.currentValue !== turn.effort) {
        throw new Error('Copilot did not acknowledge the selected model and effort. No prompt was sent.');
      }
    },
    async snapshot(env, config): Promise<ProviderSnapshot> {
      environment = env;
      command = config.cli;
      const version = await new Promise<string | undefined>(resolve => execCli(config.cli, ['--version'], { env, timeout: 8000 }, (error, stdout) => resolve(error ? undefined : stdout.trim().split('\n')[0])));
      if (!version) return { state: 'unavailable', reason: 'GitHub Copilot CLI was not found or could not start. Install it, or use Set CLI to choose its executable, then refresh.' };
      return { state: 'available', version, authenticated: await authenticated(env, config.cli) };
    },
  };
}

const base = createAcpDriver(copilotSupport());
export const CopilotDriver: ProviderDriver<AcpConfig> = {
  ...base,
  async create(input) {
    const instanceSupport = copilotSupport();
    const instance = await createAcpDriver(instanceSupport).create(input);
    const send = instance.adapter.sendTurn;
    instance.adapter.sendTurn = async turn => send(await instanceSupport.prepare(turn));
    return instance;
  },
};
