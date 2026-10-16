import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const child = spawn(process.execPath, ['--experimental-strip-types', join(root, 'server/dev-server.ts')], {
  cwd: root, stdio: 'inherit', env: { ...process.env, OMB_DATA_DIR: process.env.OMB_DATA_DIR || join(homedir(), '.copilotbot') },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 1; });
