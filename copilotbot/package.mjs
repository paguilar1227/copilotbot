import { readFileSync, existsSync, mkdirSync, writeFileSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { build, Platform, Arch } from 'electron-builder';
import { reusedDuckdbResource } from './package-resources.mjs';
import { COPILOTBOT_UPDATE_FEED } from '../electron/copilotbot-update-feed.mjs';

const root = resolve(import.meta.dirname, '..');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('CopilotBot requires Node.js 24 or newer.');
const run = (...args) => {
  const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed`);
};
const windows = process.argv.includes('--win');
if (windows && (process.platform !== 'win32' || process.arch !== 'x64')) throw new Error('Build the Windows installer on Windows x64.');
const reuseAt = process.argv.indexOf('--reuse-resources');
const reuse = reuseAt < 0 ? undefined : resolve(process.argv[reuseAt + 1]);
const config = parse(readFileSync(join(root, 'electron-builder.yml'), 'utf8'));
config.appId = 'com.paguilar.copilotbot';
config.productName = 'CopilotBot';
config.artifactName = 'CopilotBot-${version}-${arch}.${ext}';
config.publish = windows ? [COPILOTBOT_UPDATE_FEED] : null;
config.extraResources = config.extraResources.filter(entry => entry.from !== 'plugins' || existsSync(join(root, 'plugins')));
config.extraMetadata = {
  name: 'copilotbot', productName: 'CopilotBot', version: JSON.parse(readFileSync(join(root, 'copilotbot/version.json'), 'utf8')).version,
  homepage: 'https://github.com/paguilar1227/copilotbot',
  repository: { type: 'git', url: 'https://github.com/paguilar1227/copilotbot.git' },
};
config.protocols = [{ name: 'CopilotBot package install', schemes: ['copilotbot'] }];
config.directories.output = 'release-copilotbot';
config.mac.identity = null;
config.extends = null;
if (windows && reuse) throw new Error('--reuse-resources is only supported on macOS.');
if (windows) {
  run('package:prepare');
  run('build:cua:win');
  run('exec', 'node', 'copilotbot/windows/prepare-copilot.mjs');
  config.win.target = [{ target: 'nsis', arch: ['x64'] }];
  config.nsis = { ...config.nsis, oneClick: false, allowToChangeInstallationDirectory: true, shortcutName: 'CopilotBot', artifactName: 'CopilotBot-${version}-windows-x64-setup.${ext}', deleteAppDataOnUninstall: false };
  config.extraResources.push(
    { from: 'third_party/github-copilot-cli/LICENSE.md', to: 'licenses/github-copilot-cli-LICENSE.md' },
    { from: 'dist-native/copilot-win32-x64', to: 'copilot-cli', filter: ['**/*', '!copilot.zip'] },
    { from: 'dist-native/powershell-win32-x64', to: 'powershell', filter: ['**/*', '!powershell.zip'] },
    { from: 'copilotbot/windows/setup-dependency.ps1', to: 'copilotbot-setup/setup-dependency.ps1' },
  );
} else if (reuse) {
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
const buildConfig = join(root, 'release-copilotbot', 'build-config.json');
mkdirSync(join(root, 'release-copilotbot'), { recursive: true });
writeFileSync(buildConfig, JSON.stringify(config, null, 2));
await build({ targets: windows ? Platform.WINDOWS.createTarget(['nsis'], Arch.x64) : Platform.MAC.createTarget(['dir'], Arch.arm64), config: buildConfig, publish: 'never' });
if (windows) {
  const release = join(root, config.directories.output);
  const feed = parse(readFileSync(join(release, 'win-unpacked/resources/app-update.yml'), 'utf8'));
  for (const [key, value] of Object.entries(COPILOTBOT_UPDATE_FEED)) {
    if (feed[key] !== value) throw new Error(`Packaged updater has the wrong ${key}`);
  }
  const update = parse(readFileSync(join(release, 'latest.yml'), 'utf8'));
  const name = `CopilotBot-${config.extraMetadata.version}-windows-x64-setup.exe`;
  if (update.version !== config.extraMetadata.version || update.files?.[0]?.url !== name) throw new Error('Update metadata does not match the installer');
  const digest = createHash('sha512');
  for await (const chunk of createReadStream(join(release, name))) digest.update(chunk);
  if (update.files[0].sha512 !== digest.digest('base64')) throw new Error('Update metadata has the wrong installer checksum');
  if (!existsSync(join(release, `${name}.blockmap`))) throw new Error('Installer blockmap is missing');
}
