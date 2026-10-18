import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { build, Platform, Arch } from 'electron-builder';
import { reusedDuckdbResource } from './package-resources.mjs';

const root = resolve(import.meta.dirname, '..');
const upstreamPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('CopilotBot requires Node.js 24 or newer.');
const run = (...args) => {
  const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed`);
};
const reuseAt = process.argv.indexOf('--reuse-resources');
const reuse = reuseAt < 0 ? undefined : resolve(process.argv[reuseAt + 1]);
const config = parse(readFileSync(join(root, 'electron-builder.yml'), 'utf8'));
config.appId = 'com.paguilar.copilotbot';
config.productName = 'CopilotBot';
config.artifactName = 'CopilotBot-${version}-${arch}.${ext}';
config.publish = null;
config.extraMetadata = {
  name: 'copilotbot', productName: 'CopilotBot', version: `${upstreamPackage.version}-copilotbot.9`,
  homepage: 'https://github.com/paguilar1227/copilotbot',
  repository: { type: 'git', url: 'https://github.com/paguilar1227/copilotbot.git' },
};
config.protocols = [{ name: 'CopilotBot package install', schemes: ['copilotbot'] }];
config.directories.output = 'release-copilotbot';
config.mac.identity = null;
config.extends = null;
if (reuse) {
  for (const directory of ['cua-driver', 'cua-sdk', 'cloudflared', 'browser-engine', 'OpenMausBot Speech.app', 'android-platform-tools']) {
    if (!existsSync(join(reuse, directory))) throw new Error(`Missing reusable runtime: ${directory}`);
  }
  for (const script of ['build', 'build:server', 'build:companion', 'build:updater']) run(script);
  run('exec', 'node', 'scripts/prepare-cloudflared.mjs', '--current');
  run('exec', 'node', 'scripts/prepare-browser.mjs', '--current');
  config.extraResources = config.extraResources.filter(entry => !String(entry.from).includes('dist-native'));
  config.extraResources.push({ from: join(reuse, 'android-platform-tools'), to: 'android-platform-tools' });
  if (!existsSync(join(reuse, 'duckdb'))) { run('build:duckdb'); config.extraResources.push({ from: 'dist-native/duckdb/darwin-arm64/node_modules', to: 'duckdb/node_modules' }); }
  else config.extraResources.push(reusedDuckdbResource(reuse));
  config.mac.extraResources = ['cua-driver', 'cua-sdk', 'OpenMausBot Speech.app'].map(directory => ({ from: join(reuse, directory), to: directory }));
  config.mac.extraResources.push({ from: 'dist-native/cloudflared/darwin-arm64/cloudflared', to: 'cloudflared/cloudflared' }, { from: 'dist-native/browser/darwin-arm64', to: 'browser-engine' });
} else {
  run('package:prepare');
  run('build:speech');
  run('build:cua');
}
const brainSource = process.env.OPEN_BRAIN_SOURCE ?? resolve(root, '../open-brain-lite');
const brainRuntime = join(root, 'release-copilotbot', 'open-brain-runtime');
if (!existsSync(join(brainSource, 'scripts/export-runtime.mjs'))) throw new Error('Set OPEN_BRAIN_SOURCE to the authoritative Open Brain Lite checkout.');
const exportedBrain = spawnSync(process.execPath, [join(brainSource, 'scripts/export-runtime.mjs'), brainRuntime], { cwd: brainSource, stdio: 'inherit' });
if (exportedBrain.status !== 0) throw new Error('Open Brain runtime export failed');
config.extraResources.push({ from: brainRuntime, to: 'open-brain-runtime' });
const buildConfig = join(root, 'release-copilotbot', 'build-config.json');
mkdirSync(join(root, 'release-copilotbot'), { recursive: true });
writeFileSync(buildConfig, JSON.stringify(config, null, 2));
await build({ targets: Platform.MAC.createTarget(['dir'], Arch.arm64), config: buildConfig });
