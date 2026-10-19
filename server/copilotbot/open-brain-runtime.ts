import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { augmentedPath, resetPathCache } from '../env-path.ts';

export type BrainRuntimePhase = 'checking' | 'unmanaged' | 'docker-missing' | 'docker-stopped' | 'starting' | 'installing' | 'restart-required' | 'ready' | 'error';
export interface BrainRuntimeStatus {
  phase: BrainRuntimePhase;
  message: string;
  managed: boolean;
  windows: boolean;
  busy: boolean;
}
type Run = (command: string, args: string[], cwd?: string) => Promise<void>;
interface RuntimeOptions {
  endpoint: string;
  source?: string;
  data: string;
  resources?: string;
  platform?: NodeJS.Platform;
  run?: Run;
  healthy?: () => Promise<boolean>;
  changed?: () => void;
}

/** Owns setup progress independently of the capture retry journal. */
export class OpenBrainRuntime {
  private state: BrainRuntimeStatus;
  private pending?: Promise<void>;
  private readonly run: Run;
  private readonly healthy: () => Promise<boolean>;
  private readonly platform: NodeJS.Platform;
  private readonly options: RuntimeOptions;
  constructor(options: RuntimeOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
    const url = new URL(options.endpoint);
    const managed = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && Boolean(options.source && existsSync(join(options.source, 'docker-compose.yml')));
    this.state = { phase: 'checking', message: 'Checking Open Brain…', managed, windows: this.platform === 'win32', busy: false };
    this.run = options.run ?? ((command, args, cwd) => this.execute(command, args, cwd));
    this.healthy = options.healthy ?? (async () => {
      try { return (await fetch(new URL('/health', url), { signal: AbortSignal.timeout(5000) })).ok; }
      catch { return false; }
    });
  }
  status(): BrainRuntimeStatus { return { ...this.state }; }
  private set(phase: BrainRuntimePhase, message: string) {
    this.state = { ...this.state, phase, message };
    this.options.changed?.();
  }
  private execute(command: string, args: string[], cwd?: string): Promise<void> {
    mkdirSync(this.options.data, { recursive: true, mode: 0o700 });
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, windowsHide: true, env: { ...process.env, PATH: augmentedPath() }, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => appendFileSync(join(this.options.data, 'runtime.log'), chunk, { mode: 0o600 }));
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(Object.assign(new Error(`${command} exited with ${code}`), { code })));
    });
  }
  start(): Promise<void> {
    if (this.pending) return this.pending;
    this.state.busy = true;
    this.pending = this.startOnce().catch(() => {
      this.set('error', 'Open Brain could not start. Retry setup; diagnostic output is saved in open-brain/runtime.log in your CopilotBot data folder.');
    }).finally(() => { this.state.busy = false; this.pending = undefined; this.options.changed?.(); });
    return this.pending;
  }
  private async startOnce() {
    this.set('checking', 'Checking Open Brain…');
    resetPathCache();
    const envFile = join(this.options.data, 'runtime.env');
    const readyFile = join(this.options.data, 'runtime-ready.json');
    const stampFile = this.options.source && join(this.options.source, 'runtime.json');
    const stamp = stampFile && existsSync(stampFile) ? readFileSync(stampFile, 'utf8') : '';
    const verified = existsSync(readyFile) && readFileSync(readyFile, 'utf8') === stamp;
    if (await this.healthy() && (!this.state.managed || !existsSync(envFile) || verified)) { this.set('ready', 'Open Brain is ready. Notes, tasks and artifacts stay on this computer.'); return; }
    if (!this.state.managed) { this.set('unmanaged', 'The configured Open Brain service is unavailable. Check its address in App extensions.'); return; }
    try { await this.run('docker', ['compose', 'version']); }
    catch { this.set('docker-missing', 'Open Brain needs Docker Desktop. Install it below, then finish the Docker setup window.'); return; }
    try { await this.run('docker', ['info']); }
    catch { this.set('docker-stopped', 'Start Docker Desktop, finish any WSL or restart prompt, then check again.'); return; }
    const { source, data, endpoint } = this.options;
    mkdirSync(data, { recursive: true, mode: 0o700 });
    if (!existsSync(envFile)) writeFileSync(envFile, `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}\nPORT=${new URL(endpoint).port || '3210'}\nBIND_ADDRESS=127.0.0.1\n`, { mode: 0o600 });
    const args = ['compose', '--project-name', 'copilotbot-brain', '--env-file', envFile, '-f', join(source!, 'docker-compose.yml')];
    this.set('starting', 'Preparing Open Brain and its local database. The first setup downloads containers and models; keep CopilotBot open.');
    await this.run('docker', [...args, 'up', '-d', '--build', '--wait'], source);
    await this.run('docker', [...args, 'exec', '-T', 'app', 'node', 'scripts/verify-models.mjs', '--pull'], source);
    if (!await this.healthy()) throw new Error('Open Brain health check failed');
    writeFileSync(readyFile, stamp, { mode: 0o600 });
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
