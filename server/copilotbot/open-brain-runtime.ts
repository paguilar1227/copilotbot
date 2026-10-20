import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { OpenBrainUpdates, type BrainUpdateStatus, type RuntimeRun } from './open-brain-updates.ts';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { augmentedPath, resetPathCache } from '../env-path.ts';

export type BrainRuntimePhase = 'checking' | 'not-installed' | 'unmanaged' | 'docker-missing' | 'docker-stopped' | 'starting' | 'installing' | 'restart-required' | 'ready' | 'error';
export interface BrainRuntimeStatus {
  phase: BrainRuntimePhase;
  message: string;
  managed: boolean;
  windows: boolean;
  busy: boolean;
  updates?: BrainUpdateStatus;
}
type Run = RuntimeRun;
interface RuntimeOptions {
  endpoint: string;
  source?: string;
  data: string;
  resources?: string;
  platform?: NodeJS.Platform;
  run?: Run;
  healthy?: () => Promise<boolean>;
  changed?: () => void;
  projectName?: string;
  releaseFeed?: string;
  verify?: () => Promise<void>;
  maintenance?: <T>(action: () => Promise<T>) => Promise<T>;
  activate?: (source: string) => Promise<void>;
  retainPlugin?: (source: string) => void;
}

/** Owns setup progress independently of the capture retry journal. */
export class OpenBrainRuntime {
  private state: BrainRuntimeStatus;
  private pending?: Promise<void>;
  private readonly run: Run;
  private readonly healthy: () => Promise<boolean>;
  private readonly platform: NodeJS.Platform;
  private readonly options: RuntimeOptions;
  private readonly updates?: OpenBrainUpdates;
  constructor(options: RuntimeOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
    const url = new URL(options.endpoint);
    const managed = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    this.state = { phase: 'checking', message: 'Checking Open Brain…', managed, windows: this.platform === 'win32', busy: false };
    this.run = options.run ?? ((command, args, cwd, files) => this.execute(command, args, cwd, files));
    this.healthy = options.healthy ?? (async () => {
      try { return (await fetch(new URL('/health', url), { signal: AbortSignal.timeout(5000) })).ok; }
      catch { return false; }
    });
    if (managed) this.updates = new OpenBrainUpdates({ data: options.data, bundled: options.source!, projectName: options.projectName ?? 'copilotbot-brain', run: this.run,
      previous: options.resources && join(options.resources, 'open-brain-runtime-previous'),
      boot: (source, recovery) => this.boot(source, recovery), changed: () => options.changed?.(), maintenance: options.maintenance ?? (async action => action()), feed: options.releaseFeed, retainPlugin: options.retainPlugin });
  }
  status(): BrainRuntimeStatus { return { ...this.state, updates: this.state.managed ? this.updates?.status() : undefined }; }
  unavailableForWrites() { return Boolean(this.updates?.maintenance || this.updates?.recoveryRequired); }
  private set(phase: BrainRuntimePhase, message: string) {
    this.state = { ...this.state, phase, message };
    this.options.changed?.();
  }
  private async execute(command: string, args: string[], cwd?: string, files?: { input?: string; output?: string }): Promise<void> {
    mkdirSync(this.options.data, { recursive: true, mode: 0o700 });
    const child = spawn(command, args, { cwd, windowsHide: true, env: { ...process.env, PATH: augmentedPath() }, stdio: [files?.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const log = (chunk: Buffer) => appendFileSync(join(this.options.data, 'runtime.log'), chunk, { mode: 0o600 });
    child.stderr!.on('data', log);
    const tasks: Promise<unknown>[] = [new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(Object.assign(new Error(command + ' exited with ' + code), { code })));
    })];
    if (files?.input && child.stdin) tasks.push(pipeline(createReadStream(files.input), child.stdin));
    if (files?.output) tasks.push(pipeline(child.stdout!, createWriteStream(files.output, { mode: 0o600, flags: 'wx' })));
    else child.stdout!.on('data', log);
    try { await Promise.all(tasks); } catch (error) { child.kill(); throw error; }
  }
  async checkForUpdates() { if (this.updates && !this.state.busy) await this.updates.check(); }
  private async changeVersion(action: 'update' | 'rollback') {
    if (this.pending || !this.updates) return;
    this.state.busy = true;
    this.pending = this.updates[action]().catch(() => {
      this.set('error', this.updates?.recoveryRequired ? 'Recovery is required. Retry rollback before using Open Brain.' : this.updates?.status().message ?? 'Open Brain update failed; see runtime.log.');
    }).finally(() => { this.state.busy = false; this.pending = undefined; this.options.changed?.(); });
    await this.pending;
  }
  update() { return this.changeVersion('update'); }
  rollback() { return this.changeVersion('rollback'); }
  async installPlugin() {
    if (this.pending || !this.state.managed) return;
    try { await this.run('docker', ['compose', 'version']); }
    catch { this.set('docker-missing', 'Install Docker Desktop, then install the Open Brain plugin.'); return; }
    try { await this.run('docker', ['info']); }
    catch { this.set('docker-stopped', 'Start Docker Desktop, then install the Open Brain plugin.'); return; }
    await this.update();
  }
  start(): Promise<void> {
    if (this.pending) return this.pending;
    this.state.busy = true;
    this.pending = this.startOnce().catch((error: unknown) => {
      this.set('error', this.updates?.status().message ?? (error instanceof Error ? error.message : 'Open Brain could not start. See open-brain/runtime.log in your CopilotBot data folder.'));
    }).finally(() => { this.state.busy = false; this.pending = undefined; this.options.changed?.(); });
    return this.pending;
  }
  private async startOnce() {
    if (this.updates?.recoveryRequired) await this.updates.recover();
    this.set('checking', 'Checking Open Brain…');
    resetPathCache();
    const envFile = join(this.options.data, 'runtime.env');
    const healthy = await this.healthy();
    if (healthy && (!this.state.managed || (!this.updates?.source && !existsSync(envFile)))) { this.state.managed = false; this.set('ready', 'Connected to an independently managed Open Brain service.'); return; }
    if (!this.state.managed) { this.set('unmanaged', 'The configured Open Brain service is unavailable. Check its address in App extensions.'); return; }
    this.updates!.prepare();
    const readyFile = join(this.options.data, 'runtime-ready.json');
    const source = this.updates?.source ?? this.options.source;
    if (!source) { this.set('not-installed', 'Install the Open Brain Lite plugin to add shared memory, tasks and artifacts. It updates independently of CopilotBot.'); return; }
    const stampFile = source && join(source, 'runtime.json');
    const stamp = stampFile && existsSync(stampFile) ? readFileSync(stampFile, 'utf8') : '';
    const verified = existsSync(readyFile) && readFileSync(readyFile, 'utf8') === stamp;
    if (healthy && verified) { this.set('ready', 'Open Brain is ready. Notes, tasks and artifacts stay on this computer.'); return; }
    try { await this.run('docker', ['compose', 'version']); }
    catch { this.set('docker-missing', 'Open Brain needs Docker Desktop. Install it below, then finish the Docker setup window.'); return; }
    try { await this.run('docker', ['info']); }
    catch { this.set('docker-stopped', 'Start Docker Desktop, finish any WSL or restart prompt, then check again.'); return; }
    await this.boot(source, false, false);
  }
  private async boot(source: string, recovery = false, activatePlugin = true) {
    const { data, endpoint } = this.options;
    const envFile = join(data, 'runtime.env');
    mkdirSync(data, { recursive: true, mode: 0o700 });
    if (!existsSync(envFile)) writeFileSync(envFile, `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}\nPORT=${new URL(endpoint).port || '3210'}\nBIND_ADDRESS=127.0.0.1\n`, { mode: 0o600 });
    const args = ['compose', '--project-name', this.options.projectName ?? 'copilotbot-brain', '--env-file', envFile, '-f', join(source!, 'docker-compose.yml')];
    this.set('starting', 'Preparing Open Brain and its local database. The first setup downloads containers and models; keep CopilotBot open.');
    await this.run('docker', [...args, 'build'], source);
    await this.run('docker', [...args, 'up', '-d', '--wait', 'db', 'ollama'], source);
    await this.run('docker', [...args, 'up', '-d', '--no-deps', '--force-recreate', '--wait', 'app'], source);
    await this.run('docker', [...args, 'exec', '-T', 'app', 'node', 'scripts/verify-models.mjs', ...(recovery ? [] : ['--pull'])], source);
    if (!await this.healthy()) throw new Error('Open Brain health check failed');
    if (this.options.verify) await this.options.verify();
    else {
      for (const [path, key] of [['sessions', 'sessions'], ['projects', 'projects'], ['todos', 'todos']]) {
        const response = await fetch(new URL('/api/v1/' + path, endpoint));
        const value = response.ok ? await response.json() as Record<string, unknown> : {};
        if (!Array.isArray(value[key])) throw new Error('Open Brain API compatibility check failed: ' + path);
      }
      if (!(await fetch(new URL('/embedded.js', endpoint))).ok) throw new Error('Open Brain shared UI is unavailable');
    }
    const stampFile = join(source, 'runtime.json');
    writeFileSync(join(data, 'runtime-ready.json'), existsSync(stampFile) ? readFileSync(stampFile, 'utf8') : '', { mode: 0o600 });
    if (activatePlugin) await this.options.activate?.(source);
    this.set('ready', 'Open Brain is ready. Notes, tasks and artifacts stay on this computer.');
  }
  async install(dependency: 'docker' | 'wsl' | 'desktop'): Promise<void> {
    if (this.pending || !this.state.managed || this.platform !== 'win32' || !this.options.resources) return;
    const script = join(this.options.resources, 'copilotbot-setup', 'setup-dependency.ps1');
    this.state.busy = true;
    this.pending = (async () => {
      this.set('installing', dependency === 'desktop' ? 'Starting Docker Desktop…' : dependency === 'wsl' ? 'Follow the Windows administrator prompt to enable WSL.' : 'Downloading the signed Docker installer. Finish its setup window and review its license.');
      try {
        await this.run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Dependency', dependency]);
        resetPathCache();
        this.set('restart-required', 'Setup finished. Start Docker Desktop. If Windows requests a restart, restart and reopen CopilotBot; setup resumes automatically.');
      } catch (error) {
        if ([3010, 1641].includes((error as { code?: number }).code ?? -1)) { this.set('restart-required', 'Windows needs a restart. Reopen CopilotBot afterward to resume setup.'); return; }
        this.set('error', 'Setup did not finish. If you cancelled a prompt, you can retry. See open-brain/runtime.log for diagnostics.');
      }
    })().finally(() => { this.state.busy = false; this.pending = undefined; this.options.changed?.(); });
    await this.pending;
  }
}
