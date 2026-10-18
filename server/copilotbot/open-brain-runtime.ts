import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

/** Reuses a healthy upstream service; starts the bundled upstream runtime only when needed. */
export async function ensureOpenBrainRuntime(endpoint: string, source: string | undefined, data: string) {
  const url = new URL(endpoint);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || !source || !existsSync(join(source, 'docker-compose.yml'))) return;
  try { const response = await fetch(new URL('/health', url)); if (response.ok) return; } catch { /* start the local runtime below */ }
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const envFile = join(data, 'runtime.env');
  if (!existsSync(envFile)) writeFileSync(envFile, `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}\nPORT=${url.port || '3210'}\nBIND_ADDRESS=127.0.0.1\n`, { mode: 0o600 });
  await exec('docker', ['compose','--project-name','copilotbot-brain','--env-file',envFile,'-f',join(source,'docker-compose.yml'),'up','-d','--build','--wait'], { cwd: source });
  await exec('docker', ['compose','--project-name','copilotbot-brain','--env-file',envFile,'-f',join(source,'docker-compose.yml'),'exec','-T','app','node','scripts/verify-models.mjs','--pull'], { cwd: source });
}
