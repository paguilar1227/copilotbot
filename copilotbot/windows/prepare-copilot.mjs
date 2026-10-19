import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const version = '1.0.98';
export const sha256 = 'e264811888fd77217dc36e9656c13d0b9abbb0433a7041043e1d53798e31fd94';
const destination = resolve(import.meta.dirname, '../../dist-native/copilot-win32-x64');
mkdirSync(destination, { recursive: true });
const archive = join(destination, 'copilot.zip');
if (!existsSync(archive) || createHash('sha256').update(readFileSync(archive)).digest('hex') !== sha256) {
  const response = await fetch(`https://github.com/github/copilot-cli/releases/download/v${version}/copilot-win32-x64.zip`);
  if (!response.ok) throw new Error(`Copilot download failed: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(data).digest('hex') !== sha256) throw new Error('Copilot archive checksum mismatch');
  writeFileSync(archive, data);
}
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:COPILOT_ARCHIVE -DestinationPath $env:COPILOT_DEST -Force'], { env: { ...process.env, COPILOT_ARCHIVE: archive, COPILOT_DEST: destination }, stdio: 'inherit' });
const output = execFileSync(join(destination, 'copilot.exe'), ['--version'], { encoding: 'utf8' });
if (!output.includes(version)) throw new Error('Bundled Copilot version verification failed');
writeFileSync(join(destination, 'provenance.json'), JSON.stringify({ version, sha256, source: 'https://github.com/github/copilot-cli' }, null, 2));
