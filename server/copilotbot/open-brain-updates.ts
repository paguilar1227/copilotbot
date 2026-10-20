import { createHash, randomUUID } from 'node:crypto';
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic.ts';
import { downloadBrainRelease, latestBrainRelease, type BrainRelease } from './open-brain-release.ts';

export type RuntimeRun = (command: string, args: string[], cwd?: string, files?: { input?: string; output?: string }) => Promise<void>;
export interface BrainVersion { version: string; revision: string }
interface Snapshot extends BrainVersion { id: string; createdAt: string; databaseHash: string; filesHash: string }
interface Saved { active?: { source: string } & BrainVersion; bundledRevision?: string; rollback?: Snapshot; transaction?: Snapshot }
export interface BrainUpdateStatus { current?: BrainVersion; available?: BrainVersion; checking: boolean; phase: string; message?: string; rollback?: { version: string; createdAt: string }; recoveryRequired: boolean }
interface Options {
  data: string; bundled?: string; previous?: string; projectName: string; run: RuntimeRun;
  boot: (source: string, recovery?: boolean) => Promise<void>; changed: () => void;
  maintenance: <T>(action: () => Promise<T>) => Promise<T>;
  feed?: string;
  retainPlugin?: (source: string) => void;
}
async function digest(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export class OpenBrainUpdates {
  private readonly options: Options;
  private readonly file: string;
  private saved: Saved;
  private available?: BrainRelease;
  private phase = 'idle';
  private message?: string;
  private checking = false;
  maintenance = false;
  constructor(options: Options) {
    this.options = options; this.file = join(options.data, 'updates.json');
    this.saved = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
  }
  get source() { return this.saved.active?.source ?? this.options.bundled ?? ''; }
  get recoveryRequired() { return Boolean(this.saved.transaction); }
  /** Retain the runtime with the data, before an installer can replace its resources. */
  prepare() {
    if (this.saved.active) {
      if (!this.version(this.source)) throw new Error('The installed Open Brain runtime is missing. Its data has been left unchanged.');
      return false;
    }
    if (!this.options.bundled) {
      if (existsSync(join(this.options.data, 'runtime.env'))) throw new Error('The existing Open Brain runtime cannot be identified. Its data has been left unchanged.');
      return false;
    }
    const bundled = this.version(this.options.bundled);
    if (!bundled) throw new Error('The bundled Open Brain runtime has no version manifest.');
    if (!this.saved.active) {
      const ready = join(this.options.data, 'runtime-ready.json');
      let source = this.options.bundled;
      if (existsSync(join(this.options.data, 'runtime.env'))) {
        if (!existsSync(ready)) throw new Error('The existing Open Brain runtime cannot be identified. Its data has been left unchanged.');
        const installed = JSON.parse(readFileSync(ready, 'utf8')) as BrainVersion;
        const match = [this.options.bundled, this.options.previous].find(path => path && this.version(path)?.revision === installed.revision);
        if (!match) throw new Error('This installer does not include the previous Open Brain runtime. Its data has been left unchanged.');
        source = match;
      }
      const version = this.version(source)!;
      this.saved.active = { ...version, source: this.retain(source, version) };
      this.saved.bundledRevision = version.revision;
      this.save();
    }
    if (!this.version(this.source)) throw new Error('The installed Open Brain runtime is missing. Its data has been left unchanged.');
    return false;
  }
  private retain(source: string, version: BrainVersion) {
    const destination = join(this.options.data, 'versions', version.revision + '-' + randomUUID());
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    cpSync(source, destination, { recursive: true });
    return destination;
  }
  status(): BrainUpdateStatus {
    const current = this.version(this.source), rollback = this.saved.rollback;
    return { current, available: this.available && this.newerThanCurrent(this.available) ? { version: this.available.version, revision: this.available.revision } : undefined,
      checking: this.checking, phase: this.phase, message: this.message, recoveryRequired: this.recoveryRequired,
      rollback: rollback ? { version: rollback.version, createdAt: rollback.createdAt } : undefined };
  }
  private newerThanCurrent(release: BrainVersion) {
    const current = this.version(this.source);
    if (!current) return true;
    const candidate = release.version.split('.').map(Number), installed = current.version.split('.').map(Number);
    for (let index = 0; index < candidate.length; index++) { if (candidate[index] !== installed[index]) return candidate[index] > installed[index]; }
    return false;
  }
  private version(source: string): BrainVersion | undefined {
    if (!source) return undefined;
    const file = join(source, 'runtime.json');
    if (!existsSync(file)) return undefined;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return { version: value.version, revision: value.revision };
  }
  private save() { mkdirSync(this.options.data, { recursive: true, mode: 0o700 }); writeFileAtomic(this.file, JSON.stringify(this.saved), { mode: 0o600 }); }
  private progress(phase: string, message: string) { this.phase = phase; this.message = message; this.options.changed(); }
  async check() {
    if (this.checking) return;
    this.checking = true; this.options.changed();
    try { this.available = await latestBrainRelease(this.options.feed); this.message = undefined; }
    catch (error) { this.available = undefined; this.message = error instanceof Error ? error.message : 'Could not check updates'; }
    finally { this.checking = false; this.options.changed(); }
  }
  private compose(source: string, args: string[], files?: { input?: string; output?: string }) {
    return this.options.run('docker', ['compose', '--project-name', this.options.projectName, '--env-file', join(this.options.data, 'runtime.env'), '-f', join(source, 'docker-compose.yml'), ...args], source, files);
  }
  private async snapshot(): Promise<Snapshot> {
    const version = this.version(this.source);
    if (!version) throw new Error('The installed Open Brain version cannot be identified. Update cancelled.');
    const id = randomUUID(), directory = join(this.options.data, 'backups', id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.options.retainPlugin?.(this.source);
    cpSync(this.source, join(directory, 'runtime'), { recursive: true });
    cpSync(join(this.options.data, 'runtime.env'), join(directory, 'runtime.env'));
    this.progress('backing-up', 'Saving the Open Brain database, files and previous runtime.');
    await this.compose(this.source, ['stop', 'app']);
    await this.compose(this.source, ['exec', '-T', 'db', 'pg_dump', '-U', 'openbrain', '-d', 'openbrain', '-Fc', '--no-owner', '--no-acl'], { output: join(directory, 'database.dump') });
    await this.compose(this.source, ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'app', '-C', '/data', '-cf', '-', '.'], { output: join(directory, 'files.tar') });
    const result = { id, ...version, createdAt: new Date().toISOString(), databaseHash: await digest(join(directory, 'database.dump')), filesHash: await digest(join(directory, 'files.tar')) };
    writeFileAtomic(join(directory, 'snapshot.json'), JSON.stringify(result), { mode: 0o600 });
    return result;
  }
  private async restore(snapshot: Snapshot) {
    const directory = join(this.options.data, 'backups', snapshot.id), source = join(directory, 'runtime');
    if (await digest(join(directory, 'database.dump')) !== snapshot.databaseHash || await digest(join(directory, 'files.tar')) !== snapshot.filesHash) throw new Error('Backup verification failed; the existing data has not been replaced.');
    this.progress('rolling-back', 'Restoring the previous Open Brain runtime, database and files.');
    await this.compose(this.source, ['stop', 'app']);
    await this.compose(source, ['up', '-d', '--wait', 'db']);
    await this.compose(source, ['build', 'app']);
    await this.compose(source, ['exec', '-T', 'db', 'dropdb', '--force', '-U', 'openbrain', 'openbrain']);
    await this.compose(source, ['exec', '-T', 'db', 'createdb', '-U', 'openbrain', 'openbrain']);
    await this.compose(source, ['exec', '-T', 'db', 'pg_restore', '-U', 'openbrain', '-d', 'openbrain', '--no-owner', '--no-acl', '--exit-on-error'], { input: join(directory, 'database.dump') });
    await this.compose(source, ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', 'app', '-c', 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -xf - -C /data'], { input: join(directory, 'files.tar') });
    cpSync(join(directory, 'runtime.env'), join(this.options.data, 'runtime.env'));
    await this.options.boot(source, true);
    this.saved.active = { source, version: snapshot.version, revision: snapshot.revision };
  }
  private async exclusive<T>(action: () => Promise<T>) {
    this.maintenance = true; this.options.changed();
    try { return await this.options.maintenance(action); }
    finally {
      if (this.recoveryRequired) {
        try { await this.compose(this.source, ['stop', 'app']); } catch { /* The persisted recovery gate continues to reject captures. */ }
      }
      this.maintenance = false; this.options.changed();
    }
  }
  async recover() {
    const snapshot = this.saved.transaction;
    if (!snapshot) return;
    await this.exclusive(async () => { await this.restore(snapshot); delete this.saved.transaction; this.save(); this.progress('idle', 'Recovered the last working Open Brain backup after an interrupted update.'); });
  }
  async update() {
    if (this.recoveryRequired) { await this.recover(); return; }
    await this.check();
    const release = this.available;
    if (!release || !this.newerThanCurrent(release)) return;
    this.progress('downloading', 'Downloading Open Brain ' + release.version + '.');
    let source: string;
    try { source = await downloadBrainRelease(release, join(this.options.data, 'versions')); }
    catch (error) { this.progress('failed', error instanceof Error ? error.message : 'Download failed. The current version is unchanged.'); throw error; }
    if (!this.source) {
      if (existsSync(join(this.options.data, 'runtime.env'))) throw new Error('An existing Open Brain installation must be recovered before installing a plugin.');
      if (!existsSync(join(source, 'plugin/copilotbot/plugin.json'))) throw new Error('This Open Brain release does not include an installable plugin. Choose a newer compatible release.');
      this.saved.active = { source, version: release.version, revision: release.revision }; this.save();
      this.progress('installing', 'Installing Open Brain ' + release.version + '.');
      await this.options.boot(source);
      this.progress('idle', 'Open Brain ' + release.version + ' is installed.');
    } else await this.install(source, release);
  }
  private async install(source: string, release: BrainVersion) {
    await this.exclusive(async () => {
      let snapshot: Snapshot | undefined;
      try {
        snapshot = await this.snapshot();
        this.saved.transaction = snapshot; this.save();
        this.progress('installing', 'Installing Open Brain ' + release.version + ' and verifying compatibility.');
        await this.options.boot(source);
        this.saved.active = { source, version: release.version, revision: release.revision };
        this.saved.rollback = snapshot; delete this.saved.transaction; this.save();
        this.progress('idle', 'Open Brain ' + release.version + ' is ready. The previous version and data are backed up.');
      } catch (error) {
        if (snapshot) { await this.restore(snapshot); delete this.saved.transaction; this.save(); }
        else await this.options.boot(this.source, true);
        this.progress('failed', 'Update failed. The previous Open Brain version is running; its data was preserved.');
        throw error;
      }
    });
  }
  async rollback() {
    if (this.recoveryRequired) { await this.recover(); return; }
    const target = this.saved.rollback;
    if (!target) throw new Error('No previous Open Brain version is available.');
    await this.exclusive(async () => {
      let current: Snapshot | undefined;
      try {
        current = await this.snapshot();
        this.saved.transaction = current; this.save();
        await this.restore(target);
        this.saved.rollback = current; delete this.saved.transaction; this.save();
        this.progress('idle', 'Previous Open Brain version restored. The state from before rollback is also backed up.');
      } catch (error) {
        if (current) { await this.restore(current); delete this.saved.transaction; this.save(); }
        else await this.options.boot(this.source, true);
        this.progress('failed', 'Rollback failed. The state from before rollback was restored.');
        throw error;
      }
    });
  }
}
