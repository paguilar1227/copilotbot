import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync, cpSync } from 'node:fs';
import { dirname, join, resolve, sep, extname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { pluginManifestSchema, type PluginListing, type PluginManifest, type PluginSettings } from '../../shared/plugins.ts';
import { setPluginContributions } from './contributions.ts';
import type { StoredMcpServer } from '../mcp-registry.ts';

interface Installation { directory: string; enabled: boolean; settings: PluginSettings; disabledSkills?: string[] }
interface Runtime {
  worker: Worker; status: 'starting' | 'ready' | 'error'; error?: string;
  ready: Promise<void>;
  abort: AbortController; pending: Map<string, { resolve(value: unknown): void; reject(error: Error): void }>;
}
interface Loaded { installation: Installation; manifest: PluginManifest; runtime?: Runtime; error?: string }

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}

/** Packages cannot contain symlinks, traversal paths or special files, including in nested assets. */
export function pluginFile(root: string, relative: string): string {
  if (!relative || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid plugin file path');
  const base = realpathSync(root), file = resolve(base, relative);
  if (!file.startsWith(`${base}${sep}`)) throw new Error('Plugin path leaves the package');
  let current = base;
  for (const part of relative.split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Plugin symlinks are not supported');
  }
  if (!lstatSync(file).isFile()) throw new Error('Plugin asset is not a regular file');
  return file;
}

function validateTree(root: string) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('Plugin packages must contain only regular files and directories');
    if (entry.isDirectory()) validateTree(join(root, entry.name));
  }
}

function readManifest(directory: string): PluginManifest {
  const manifest = pluginManifestSchema.parse(JSON.parse(readFileSync(pluginFile(directory, 'plugin.json'), 'utf8')));
  for (const file of [manifest.backend, ...manifest.pages.map(page => page.entry), ...manifest.skills.map(skill => skill.file)]) if (file) pluginFile(directory, file);
  return manifest;
}

export function discoverPlugins(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(directory, entry.name, 'plugin.json'))).map(entry => join(directory, entry.name));
}

function settingsFor(manifest: PluginManifest, raw: unknown, previous: PluginSettings = {}, requireValues = true): PluginSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Plugin settings must be an object');
  const result: PluginSettings = {};
  for (const key of Object.keys(raw)) if (!manifest.settings[key]) throw new Error(`Unknown plugin setting: ${key}`);
  for (const [key, field] of Object.entries(manifest.settings)) {
    const value = (raw as Record<string, unknown>)[key] ?? previous[key] ?? field.default ?? (field.type === 'boolean' ? false : '');
    if (field.type === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'string') throw new Error(`Invalid setting: ${field.label}`);
    if (requireValues && field.required && !value) throw new Error(`${field.label} is required`);
    if (field.type === 'url' && value) {
      const url = new URL(String(value));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${field.label} must be an HTTP(S) URL without credentials, query or fragment`);
    }
    result[key] = value as string | boolean;
  }
  return result;
}

export class PluginHost {
  private plugins = new Map<string, Loaded>();
  private index: string;
  private root: string;
  private changed: () => void;
  private workerPath?: URL;
  private readonly serviceAvailable: (id: string) => boolean;
  error?: string;
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(root: string, changed: () => void = () => {}, workerPath?: URL, serviceAvailable: (id: string) => boolean = () => true) {
    this.root = root; this.changed = changed;
    this.workerPath = workerPath; this.serviceAvailable = serviceAvailable;
    this.index = join(root, 'plugins.json');
  }

  private change<T>(run: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(run);
    this.mutation = result.catch(() => {});
    return result;
  }

  async start(bundled: string[] = []): Promise<void> {
    if (existsSync(this.index)) {
      let entries: unknown;
      try {
        entries = JSON.parse(readFileSync(this.index, 'utf8'));
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Invalid index');
      } catch { this.error = 'The plugin index could not be read. Restore plugins.json from a backup before changing extensions.'; return; }
      for (const [id, entry] of Object.entries(entries)) {
        try {
          const installation = entry as Installation;
          const directory = realpathSync(installation.directory);
          if (!directory.startsWith(`${realpathSync(this.root)}${sep}packages${sep}`)) throw new Error('Invalid installed plugin location');
          const manifest = readManifest(directory);
          if (manifest.id !== id || typeof installation.enabled !== 'boolean') throw new Error('Invalid plugin installation');
          if (installation.disabledSkills && (!Array.isArray(installation.disabledSkills) || installation.disabledSkills.some(name => typeof name !== 'string'))) throw new Error('Invalid plugin skill state');
          installation.settings = settingsFor(manifest, installation.settings, {}, installation.enabled);
          this.plugins.set(id, { installation, manifest });
        } catch { this.plugins.set(id, { installation: { directory: '', enabled: false, settings: {} }, manifest: { format: 'copilotbot.plugin', apiVersion: 1, id, name: id, version: '0.0.0', description: 'Reinstall this plugin to recover its files.', pages: [], commands: [], settings: {}, services: {}, mcp: [], skills: [] }, error: 'Installed plugin could not be read. Reinstall it to recover.' }); }
      }
    }
    for (const directory of bundled) {
      const manifest = readManifest(directory);
      const previous = this.plugins.get(manifest.id);
      if (!previous) await this.install(directory);
      else if (previous.manifest.version !== manifest.version) {
        const enabled = previous.installation.enabled;
        previous.installation.enabled = false;
        try { await this.install(directory); this.get(manifest.id).installation.enabled = enabled; this.save(); }
        catch (error) { previous.installation.enabled = enabled; throw error; }
      }
    }
    for (const plugin of this.plugins.values()) if (plugin.installation.enabled) this.launch(plugin);
    this.publish();
  }

  list(): PluginListing[] { return [...this.plugins.values()].map(plugin => this.listing(plugin)); }
  get(id: string): Loaded {
    const plugin = this.plugins.get(id);
    if (!plugin) throw Object.assign(new Error('Plugin not found'), { status: 404 });
    return plugin;
  }

  private listing(plugin: Loaded): PluginListing {
    const settings = Object.fromEntries(Object.entries(plugin.installation.settings).filter(([key]) => plugin.manifest.settings[key]?.type !== 'secret'));
    return { manifest: plugin.manifest, settings, configuredSecrets: Object.entries(plugin.manifest.settings).filter(([key, field]) => field.type === 'secret' && plugin.installation.settings[key]).map(([key]) => key), enabled: plugin.installation.enabled, status: plugin.error ? 'error' : plugin.runtime?.status ?? (plugin.installation.enabled ? 'ready' : 'disabled'), ...(plugin.error || plugin.runtime?.error ? { error: plugin.error ?? plugin.runtime?.error } : {}) };
  }

  install(source: string): Promise<PluginListing> { return this.change(() => this.installCopy(source)); }
  replace(source: string, settings: PluginSettings = {}): Promise<PluginListing> {
    return this.change(async () => {
      const manifest = readManifest(source);
      const previous = this.plugins.get(manifest.id);
      if (previous?.manifest.version === manifest.version && Object.entries(settings).every(([key, value]) => previous.installation.settings[key] === value)) return this.listing(previous);
      const enabled = previous?.installation.enabled ?? true;
      if (previous) { await this.stop(previous); previous.installation.enabled = false; }
      try {
        await this.installCopy(source);
        if (Object.keys(settings).length) await this.configureSaved(manifest.id, settings);
        await this.setEnabled(manifest.id, enabled);
        await this.get(manifest.id).runtime?.ready;
        return this.listing(this.get(manifest.id));
      } catch (error) {
        const current = this.plugins.get(manifest.id);
        if (current && current !== previous) await this.stop(current);
        if (previous) {
          this.plugins.set(manifest.id, previous); previous.installation.enabled = enabled;
          this.save(); if (enabled) this.launch(previous); this.publish();
        } else { this.plugins.delete(manifest.id); this.save(); this.publish(); }
        throw error;
      }
    });
  }
  private async installCopy(source: string): Promise<PluginListing> {
    if (this.error) throw new Error(this.error);
    if (!source || !isAbsolute(source)) throw new Error('Choose an absolute plugin folder path');
    const original = realpathSync(source);
    validateTree(original);
    const manifest = readManifest(original);
    const previous = this.plugins.get(manifest.id);
    if (previous?.installation.enabled) throw new Error('Disable this plugin before installing another version');
    const directory = join(this.root, 'packages', manifest.id, randomUUID());
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    cpSync(original, directory, { recursive: true, dereference: false });
    validateTree(directory);
    const copied = readManifest(directory);
    if (JSON.stringify(copied) !== JSON.stringify(manifest)) throw new Error('Plugin changed during installation. Try again.');
    const retained = Object.fromEntries(Object.entries(previous?.installation.settings ?? {}).filter(([key]) => previous?.manifest.settings[key]?.type === copied.settings[key]?.type));
    const plugin: Loaded = { manifest: copied, installation: { directory, enabled: false, settings: settingsFor(copied, {}, retained, false), disabledSkills: previous?.installation.disabledSkills ?? [] } };
    this.plugins.set(copied.id, plugin); this.save(); this.publish();
    return this.listing(plugin);
  }

  configure(id: string, raw: unknown): Promise<PluginListing> { return this.change(() => this.configureSaved(id, raw)); }
  private async configureSaved(id: string, raw: unknown): Promise<PluginListing> {
    const plugin = this.get(id);
    if (!plugin.installation.directory) throw new Error(plugin.error ?? 'Reinstall this plugin');
    const settings = settingsFor(plugin.manifest, raw, plugin.installation.settings);
    await this.stop(plugin);
    plugin.error = undefined;
    plugin.installation.settings = settings; this.save();
    if (plugin.installation.enabled) this.launch(plugin);
    this.publish(); return this.listing(plugin);
  }

  enable(id: string, enabled: boolean): Promise<PluginListing> { return this.change(() => this.setEnabled(id, enabled)); }
  private async setEnabled(id: string, enabled: boolean): Promise<PluginListing> {
    const plugin = this.get(id);
    await this.stop(plugin);
    if (enabled && !plugin.installation.directory) throw new Error(plugin.error ?? 'Reinstall this plugin');
    if (enabled) {
      settingsFor(plugin.manifest, plugin.installation.settings);
      for (const mcp of plugin.manifest.mcp) this.serviceUrl(plugin, mcp.service, mcp.path);
      for (const other of this.plugins.values()) {
        if (other === plugin || !other.installation.enabled) continue;
        if (other.manifest.mcp.some(a => plugin.manifest.mcp.some(b => a.name === b.name)) || other.manifest.skills.some(a => plugin.manifest.skills.some(b => a.name === b.name))) throw new Error('An enabled plugin already contributes the same MCP server or skill name');
      }
    }
    if (plugin.installation.directory) plugin.error = undefined;
    plugin.installation.enabled = enabled; this.save();
    if (enabled) this.launch(plugin);
    this.publish(); return this.listing(plugin);
  }

  private save() { writeJson(this.index, Object.fromEntries([...this.plugins].map(([id, plugin]) => [id, plugin.installation]))); }

  setSkillEnabled(name: string, enabled: boolean): Promise<{ name: string; enabled: boolean }> {
    return this.change(async () => {
      const plugin = [...this.plugins.values()].find(plugin => plugin.installation.enabled && plugin.manifest.skills.some(skill => skill.name === name));
      if (!plugin) throw Object.assign(new Error('Plugin skill not found'), { status: 404 });
      const disabled = new Set(plugin.installation.disabledSkills ?? []);
      if (enabled) disabled.delete(name); else disabled.add(name);
      plugin.installation.disabledSkills = [...disabled];
      this.save(); this.publish();
      return { name, enabled };
    });
  }
  private safeError(plugin: Loaded, error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const [key, field] of Object.entries(plugin.manifest.settings)) if (field.type === 'secret' && plugin.installation.settings[key]) message = message.split(String(plugin.installation.settings[key])).join('[redacted]');
    return message;
  }

  private launch(plugin: Loaded) {
    if (!plugin.manifest.backend) { this.publish(); return; }
    const entry = pluginFile(plugin.installation.directory, plugin.manifest.backend);
    const workerPath = this.workerPath ?? new URL(existsSync(new URL('./worker.js', import.meta.url)) ? './worker.js' : './worker.ts', import.meta.url);
    const worker = new Worker(workerPath, { workerData: { entry, commands: plugin.manifest.commands.map(command => command.id), settings: this.listing(plugin).settings }, stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => {});
    const runtime: Runtime = { worker, status: 'starting', ready, abort: new AbortController(), pending: new Map() };
    plugin.runtime = runtime;
    const fail = (error: unknown) => {
      if (plugin.runtime !== runtime) return;
      runtime.status = 'error'; runtime.error = this.safeError(plugin, error); runtime.abort.abort();
      rejectReady(new Error(runtime.error));
      for (const request of runtime.pending.values()) request.reject(new Error(runtime.error));
      runtime.pending.clear(); this.publish();
    };
    worker.on('error', fail);
    worker.on('exit', code => { if (plugin.runtime === runtime) fail(new Error(`Plugin stopped (exit ${code}). Disable and enable to restart.`)); });
    worker.on('message', async message => {
      if (plugin.runtime !== runtime) return;
      if (message.type === 'ready') { runtime.status = 'ready'; resolveReady(); this.publish(); }
      else if (message.type === 'failed') { fail(new Error(message.error)); void worker.terminate(); }
      else if (message.type === 'result') {
        const request = runtime.pending.get(message.id); runtime.pending.delete(message.id);
        if (message.error) request?.reject(new Error(this.safeError(plugin, message.error))); else request?.resolve(message.result);
      } else if (message.type === 'host') {
        try { const result = await this.hostCall(plugin, runtime, message.method, message.input); if (plugin.runtime === runtime) worker.postMessage({ type: 'host-result', id: message.id, result }); }
        catch (error) { if (plugin.runtime === runtime) worker.postMessage({ type: 'host-result', id: message.id, error: this.safeError(plugin, error) }); }
      }
    });
  }

  private async hostCall(plugin: Loaded, runtime: Runtime, method: string, input: any) {
    if (!input || typeof input !== 'object') throw new Error('Invalid host request');
    if (method === 'services.request') {
      const target = this.serviceUrl(plugin, input.service, input.path);
      const options = input.options ?? {};
      const service = plugin.manifest.services[input.service]!;
      const token = service.tokenSetting ? plugin.installation.settings[service.tokenSetting] : undefined;
      const response = await fetch(target, { method: options.method ?? 'GET', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), redirect: 'error', signal: runtime.abort.signal });
      if (!response.ok) throw new Error(`Service returned HTTP ${response.status}. Check the service address and sign-in settings.`);
      return response.json();
    }
    if (!['storage.get', 'storage.set'].includes(method) || typeof input.key !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(input.key)) throw new Error('Invalid plugin storage request');
    const file = join(this.root, 'data', plugin.manifest.id, `${input.key}.json`);
    if (method === 'storage.get') return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    writeJson(file, input.value); return { ok: true };
  }

  private serviceUrl(plugin: Loaded, name: string, path: string): URL {
    if (!this.serviceAvailable(plugin.manifest.id)) throw Object.assign(new Error('This service is updating or requires recovery. Try again after recovery finishes.'), { status: 503 });
    const service = plugin.manifest.services[name];
    if (!service || typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error('Unknown service or invalid service path');
    const base = new URL(String(plugin.installation.settings[service.urlSetting]));
    const target = new URL(`${base.pathname.replace(/\/$/, '')}${path}`, base);
    if (target.origin !== base.origin || target.username || target.password || target.hash) throw new Error('Service request leaves its configured origin');
    return target;
  }

  async requestService(id: string, service: string, path: string, options: RequestInit = {}): Promise<Response> {
    const plugin = this.get(id);
    const target = this.serviceUrl(plugin, service, path);
    const definition = plugin.manifest.services[service]!;
    const token = definition.tokenSetting ? plugin.installation.settings[definition.tokenSetting] : undefined;
    const headers = new Headers(options.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(target, { ...options, headers, redirect: 'error' });
  }

  async invoke(id: string, command: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.serviceAvailable(id)) throw Object.assign(new Error('This service is updating or requires recovery.'), { status: 503 });
    const plugin = this.get(id), runtime = plugin.runtime;
    if (!plugin.installation.enabled || !runtime || runtime.status !== 'ready') throw Object.assign(new Error('Plugin is not ready. Enable it or check its status.'), { status: 409 });
    if (!plugin.manifest.commands.some(row => row.id === command)) throw Object.assign(new Error('Unknown plugin command'), { status: 404 });
    if (signal?.aborted) throw new Error('Request canceled');
    const requestId = randomUUID();
    return new Promise((resolveRequest, reject) => {
      const cancel = () => { runtime.pending.delete(requestId); reject(new Error('Request canceled')); };
      signal?.addEventListener('abort', cancel, { once: true });
      runtime.pending.set(requestId, {
        resolve: value => { signal?.removeEventListener('abort', cancel); resolveRequest(value); },
        reject: error => { signal?.removeEventListener('abort', cancel); reject(error); },
      });
      runtime.worker.postMessage({ type: 'command', id: requestId, command, input });
    });
  }

  asset(id: string, relative: string): { body: Buffer; mime: string } {
    const plugin = this.get(id);
    if (!plugin.installation.enabled || plugin.runtime?.status === 'error') throw Object.assign(new Error('Plugin is disabled or unavailable'), { status: 409 });
    if (!plugin.manifest.pages.some(page => relative === page.entry || relative.startsWith(`${dirname(page.entry)}/`))) throw new Error('Asset is outside the plugin pages');
    const file = pluginFile(plugin.installation.directory, relative), extension = extname(file);
    const mime = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' } as Record<string, string>)[extension];
    if (!mime) throw new Error('Unsupported plugin asset');
    return { body: readFileSync(file), mime };
  }

  private async stop(plugin: Loaded) {
    const runtime = plugin.runtime;
    plugin.runtime = undefined;
    this.publish();
    if (!runtime) return;
    runtime.abort.abort();
    for (const request of runtime.pending.values()) request.reject(new Error('Plugin stopped'));
    runtime.pending.clear();
    // Termination is unconditional: third-party code cannot block disabling a plugin.
    await runtime.worker.terminate();
  }

  private publish() {
    const mcp: Record<string, StoredMcpServer> = {}, skills: ReturnType<typeof import('./contributions.ts').pluginSkills> = [];
    for (const plugin of this.plugins.values()) {
      if (!plugin.installation.enabled || plugin.error || (plugin.manifest.backend && plugin.runtime?.status !== 'ready')) continue;
      for (const contribution of plugin.manifest.mcp) {
        try {
          if (mcp[contribution.name]) throw new Error('Duplicate plugin MCP name');
          const service = plugin.manifest.services[contribution.service]!;
          const token = service.tokenSetting ? plugin.installation.settings[service.tokenSetting] : undefined;
          mcp[contribution.name] = { type: 'http', url: this.serviceUrl(plugin, contribution.service, contribution.path).href, enabled: true, headers: token ? { Authorization: `Bearer ${token}` } : {} };
        } catch { plugin.error = 'Plugin MCP contribution is invalid or conflicts with another plugin'; }
      }
      for (const skill of plugin.manifest.skills) skills.push({ ...skill, file: pluginFile(plugin.installation.directory, skill.file), plugin: plugin.manifest.name, enabled: !plugin.installation.disabledSkills?.includes(skill.name) });
    }
    setPluginContributions(mcp, skills); this.changed();
  }

  async close() { await Promise.all([...this.plugins.values()].map(plugin => this.stop(plugin))); setPluginContributions({}, []); }
}
