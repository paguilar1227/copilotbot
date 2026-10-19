import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { latestBrainRelease, type BrainRelease } from '../server/copilotbot/open-brain-release.ts';
export function updateOpenBrainPin(root: string, release: BrainRelease) {
  const pinPath = join(root, 'copilotbot/open-brain-version.json');
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  if (pin.revision === release.revision) return false;
  const parts = release.version.split('.').map(Number), previous = pin.version.split('.').map(Number);
  const newer = parts.findIndex((value, index) => value !== previous[index]);
  if (newer < 0 || parts[newer] < previous[newer]) return false;
  const versionPath = join(root, 'copilotbot/version.json');
  const app = JSON.parse(readFileSync(versionPath, 'utf8'));
  const match = /^(.*-copilotbot\.)(\d+)$/.exec(app.version);
  if (!match) throw new Error('CopilotBot version format is invalid');
  writeFileSync(pinPath, JSON.stringify({ version: release.version, revision: release.revision }, null, 2) + '\n');
  writeFileSync(versionPath, JSON.stringify({ version: match[1] + (Number(match[2]) + 1) }, null, 2) + '\n');
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const release = await latestBrainRelease();
  const changed = release ? updateOpenBrainPin(resolve(import.meta.dirname, '..'), release) : false;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'changed=' + changed + '\nversion=' + (release?.version ?? '') + '\n');
  console.log(changed ? 'Prepared Open Brain ' + release!.version : 'Open Brain pin is current.');
}
