import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// Match OpenMausBot's ACP initialize/session-new timeout, not an inference budget.
export const ACP_TIMEOUT_MS = 300_000;
export const DEFAULT_MODEL = 'agent-default';

export function effortVariants(session) {
  const setting = session?.configOptions?.find(option => option.type === 'select'
    && (option.id === 'reasoning_effort' || option.id === 'effort' || option.category === 'thought_level'));
  const variants = new Map();
  const collect = entries => {
    for (const entry of entries ?? []) {
      if (typeof entry.value === 'string') {
        const name = entry.name || entry.value;
        variants.set(entry.value, { id: entry.value,
          label: entry.value === 'xhigh' ? 'Extra high' : name.charAt(0).toUpperCase() + name.slice(1) });
      } else if (Array.isArray(entry.options)) collect(entry.options);
    }
  };
  collect(setting?.options);
  return [...variants.values()];
}

export function catalogFromSession(session) {
  const select = session?.configOptions?.find(option => option.id === 'model' && option.type === 'select');
  const entries = select?.options ?? session?.models?.availableModels ?? [];
  const options = new Map();
  for (const entry of entries) {
    const id = entry.value ?? entry.modelId;
    if (typeof id !== 'string' || !id || entry._meta?.copilotEnablement === 'disabled') continue;
    options.set(id, { id, label: entry.name || id });
  }
  if (!options.size) throw new Error('Copilot returned no available models. Check its login and subscription.');
  const current = select?.currentValue ?? session?.models?.currentModelId;
  if (!options.has(current)) throw new Error('Copilot did not identify an available default model.');
  return { default: current, options: [...options.values()] };
}

/** Discover with ACP alone: no prompt, tools, credentials, or model inference. */
export async function discoverCopilot({ cli, env, spawn, kill, timeoutMs = ACP_TIMEOUT_MS, cwd }) {
  // Keep project instructions out of catalog discovery. Leave the empty folder intact;
  // Copilot can retain its path in a native session record after the process exits.
  const directory = cwd ?? await mkdtemp(join(tmpdir(), 'mausbot-copilot-catalog-'));
  const child = spawn(cli, ['--acp', '--disable-builtin-mcps', '--no-custom-instructions', '--log-level', 'error'], {
    cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume();
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  const failAll = error => {
    closed = true;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  };
  child.on('error', () => failAll(new Error('Could not start Copilot CLI for model discovery.')));
  child.on('exit', () => failAll(new Error('Copilot exited before completing model discovery.')));
  child.stdin.on('error', () => failAll(new Error('Copilot closed its ACP input during model discovery.')));
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; } // CLI banners are not protocol messages.
    if (message.method && message.id !== undefined) {
      // Catalog inspection must never grant a tool or file request.
      send(message.method === 'session/request_permission'
        ? { jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } }
        : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Model discovery does not provide tools.' } });
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(`Copilot rejected ${waiter.method} (RPC ${message.error.code}). Check its CLI login.`));
    } else waiter.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('Copilot discovery process is closed.'));
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Copilot model discovery timed out during ${method}.`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, method });
    send({ jsonrpc: '2.0', id, method, params });
  });
  try {
    const init = await request('initialize', {
      protocolVersion: 1, clientCapabilities: {},
      clientInfo: { name: 'mausbot-copilot-catalog', version: '1.0.0' },
    });
    let session = await request('session/new', { cwd: directory, mcpServers: [] });
    const sessionId = session.sessionId;
    if (typeof sessionId !== 'string') throw new Error('Copilot returned no session ID for effort discovery.');
    const catalog = catalogFromSession(session);
    for (const model of catalog.options) {
      const current = catalogFromSession(session).default;
      if (current !== model.id) {
        session = await request('session/set_config_option', {
          sessionId, configId: 'model', value: model.id,
        });
        if (catalogFromSession(session).default !== model.id) {
          throw new Error(`Copilot did not select ${model.id} during effort discovery.`);
        }
      }
      model.variants = effortVariants(session);
    }
    return { catalog, version: init.agentInfo?.version ?? 'unknown' };
  } finally {
    lines.close();
    failAll(new Error('Copilot model discovery finished.'));
    await kill(child);
  }
}
