import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { z } from 'zod';
import { pluginManifestSchema } from '../../shared/plugins.ts';

export const brainReleaseSchema = z.object({
  schemaVersion: z.literal(1), apiVersion: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/), revision: z.string().regex(/^[a-f0-9]{40}$/),
  archive: z.literal('open-brain-runtime.tar.gz'), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
}).strict();
export type BrainRelease = z.infer<typeof brainReleaseSchema> & { url: string };
export const BRAIN_RELEASE_FEED = 'https://api.github.com/repos/paguilar1227/open-brain-lite/releases/latest';

export async function latestBrainRelease(feed = BRAIN_RELEASE_FEED): Promise<BrainRelease | undefined> {
  const response = await fetch(feed, { headers: { Accept: 'application/vnd.github+json' } });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error('Could not check Open Brain releases: HTTP ' + response.status);
  const release = await response.json() as { draft: boolean; prerelease: boolean; tag_name: string; assets: { name: string; browser_download_url: string }[] };
  if (release.draft || release.prerelease) return undefined;
  const asset = (name: string) => {
    const value = release.assets.find(item => item.name === name)?.browser_download_url;
    if (!value) throw new Error('The Open Brain release is missing ' + name);
    const url = new URL(value), source = new URL(feed);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname);
    const expected = 'https://github.com/paguilar1227/open-brain-lite/releases/download/' + encodeURIComponent(release.tag_name) + '/';
    if (local ? url.origin !== source.origin : !value.startsWith(expected)) throw new Error('Unexpected Open Brain asset address');
    return value;
  };
  const manifestResponse = await fetch(asset('open-brain-runtime.json'));
  if (!manifestResponse.ok) throw new Error('Could not read the Open Brain release manifest');
  const manifest = brainReleaseSchema.parse(await manifestResponse.json());
  if ('v' + manifest.version !== release.tag_name) throw new Error('Open Brain release version does not match its tag');
  return { ...manifest, url: asset(manifest.archive) };
}

export async function extractBrainRelease(archive: string, destination: string, release: BrainRelease): Promise<void> {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const part of createReadStream(archive)) { hash.update(part); bytes += part.length; }
  if (bytes !== release.bytes || hash.digest('hex') !== release.sha256) throw new Error('Open Brain download checksum does not match its release');
  let unsafe = false;
  await tar.t({ file: archive, strict: true, onReadEntry(entry) {
    const name = entry.path.replace(/^\.\//, '').replace(/\/$/, '');
    if (entry.header.path?.includes('\\') || name.startsWith('/') || name.includes(':') || name.split('/').includes('..') ||
      !['File', 'Directory'].includes(entry.type)) unsafe = true;
  } });
  if (unsafe) throw new Error('Open Brain package contains an unsafe path or link');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  await tar.x({ file: archive, cwd: destination, strict: true, preservePaths: false, umask: 0o077, noChmod: true });
  const identity = JSON.parse(readFileSync(join(destination, 'runtime.json'), 'utf8'));
  if (identity.revision !== release.revision || identity.version !== release.version || identity.apiVersion !== release.apiVersion ||
    !['docker-compose.yml', 'Dockerfile', 'scripts/verify-models.mjs'].every(file => existsSync(join(destination, file)))) {
    throw new Error('Open Brain package identity or required files do not match its release');
  }
  const pluginPath = join(destination, 'plugin/copilotbot');
  if (existsSync(join(pluginPath, 'plugin.json'))) {
    const plugin = pluginManifestSchema.parse(JSON.parse(readFileSync(join(pluginPath, 'plugin.json'), 'utf8')));
    if (plugin.id !== 'open-brain-lite' || plugin.version !== release.version ||
      [plugin.backend, ...plugin.pages.map(page => page.entry), ...plugin.skills.map(skill => skill.file)].some(file => file && !existsSync(join(pluginPath, file)))) {
      throw new Error('Open Brain plugin identity or required files do not match its release');
    }
  }
}

export async function downloadBrainRelease(release: BrainRelease, directory: string): Promise<string> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const staging = join(directory, '.download-' + randomUUID()), archive = staging + '.tar.gz';
  const destination = join(directory, release.revision + '-' + randomUUID());
  const response = await fetch(release.url);
  if (!response.ok || !response.body) throw new Error('Could not download Open Brain: HTTP ' + response.status);
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archive, { mode: 0o600, flags: 'wx' }));
    await extractBrainRelease(archive, staging, release);
    renameSync(staging, destination);
    return destination;
  } finally {
    if (existsSync(archive)) rmSync(archive);
    if (existsSync(staging)) rmSync(staging, { recursive: true });
  }
}
