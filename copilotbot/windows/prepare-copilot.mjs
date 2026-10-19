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
execFileSync('tar.exe', ['-xf', archive, '-C', destination], { stdio: 'inherit' });
const output = execFileSync(join(destination, 'copilot.exe'), ['--version'], { encoding: 'utf8' });
if (!output.includes(version)) throw new Error('Bundled Copilot version verification failed');
writeFileSync(join(destination, 'provenance.json'), JSON.stringify({ version, sha256, source: 'https://github.com/github/copilot-cli' }, null, 2));

const shellVersion = '7.6.7';
const shellSha256 = 'd2f952ebdbf24386cb8923553aa58e41a846db35a6155ea04c58142a4b16dbb7';
const shellDestination = resolve(import.meta.dirname, '../../dist-native/powershell-win32-x64');
mkdirSync(shellDestination, { recursive: true });
const shellArchive = join(shellDestination, 'powershell.zip');
if (!existsSync(shellArchive) || createHash('sha256').update(readFileSync(shellArchive)).digest('hex') !== shellSha256) {
  const response = await fetch(`https://github.com/PowerShell/PowerShell/releases/download/v${shellVersion}/PowerShell-${shellVersion}-win-x64.zip`);
  if (!response.ok) throw new Error(`PowerShell download failed: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(data).digest('hex') !== shellSha256) throw new Error('PowerShell archive checksum mismatch');
  writeFileSync(shellArchive, data);
}
execFileSync('tar.exe', ['-xf', shellArchive, '-C', shellDestination], { stdio: 'inherit' });
const shellOutput = execFileSync(join(shellDestination, 'pwsh.exe'), ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
if (shellOutput.trim() !== shellVersion) throw new Error('Bundled PowerShell version verification failed');
writeFileSync(join(shellDestination, 'provenance.json'), JSON.stringify({ version: shellVersion, sha256: shellSha256, source: 'https://github.com/PowerShell/PowerShell' }, null, 2));
