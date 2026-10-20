import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as tar from 'tar';
import { launchVerificationServer } from '../control-omb.ts';
import { freePortBlock } from '../../server/testing/ports.ts';
const root = resolve(import.meta.dirname, '../..');
const brain = process.env.OPEN_BRAIN_SOURCE;
assert(brain && existsSync(join(brain, 'scripts/export-runtime.mjs')), 'Set OPEN_BRAIN_SOURCE to the isolated Open Brain checkout');
const output = resolve(process.env.BRAIN_TEST_OUTPUT ?? join(root, 'scratch/open-brain-update-proof'));
mkdirSync(output, { recursive: true });
const workspace = mkdtempSync(join(tmpdir(), 'brain-runtime-e2e-'));
const previous = join(workspace, 'previous'), next = join(workspace, 'next'), bad = join(workspace, 'bad');
execFileSync(process.execPath, [join(brain, 'scripts/export-runtime.mjs'), previous]);
const identity = (directory: string, version: string, revision: string) => {
  writeFileSync(join(directory, 'runtime.json'), JSON.stringify({ version, revision, apiVersion: 1 }));
  const file = join(directory, 'plugin/copilotbot/plugin.json');
  const plugin = JSON.parse(readFileSync(file, 'utf8')); plugin.version = version; writeFileSync(file, JSON.stringify(plugin));
};
identity(previous, '0.1.0', '0'.repeat(40)); cpSync(previous, next, { recursive: true }); identity(next, '0.1.1', '1'.repeat(40));
cpSync(next, bad, { recursive: true }); identity(bad, '0.1.2', '2'.repeat(40));
writeFileSync(join(bad, 'scripts/fail-upgrade.cjs'), "const {Client}=require('pg'); (async()=>{const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();await db.query(\"UPDATE todos SET content='broken migration'\");require('fs').writeFileSync('/data/bad-upgrade','corrupt');require('fs').writeFileSync('/proof/mutated','database and files changed');await db.end();process.exit(1)})()");
writeFileSync(join(bad, 'Dockerfile'), readFileSync(join(bad, 'Dockerfile'), 'utf8') + '\nCOPY scripts/fail-upgrade.cjs scripts/fail-upgrade.cjs\nCMD ["node", "scripts/fail-upgrade.cjs"]\n');
const packages: Record<string, { bytes: Buffer; manifest: Record<string, unknown> }> = {};
let offered = '0.1.0', feed = '';
const releaseServer = createServer((req, res) => {
  const item = packages[offered];
  if (req.url === '/release') res.end(JSON.stringify({ draft: false, prerelease: false, tag_name: 'v' + offered, assets: ['open-brain-runtime.json', 'open-brain-runtime.tar.gz'].map(name => ({ name, browser_download_url: feed + '/' + name })) }));
  else if (req.url === '/open-brain-runtime.json') res.end(JSON.stringify(item.manifest));
  else res.end(item.bytes);
});
await new Promise<void>(resolve => releaseServer.listen(0, '127.0.0.1', resolve));
feed = 'http://127.0.0.1:' + (releaseServer.address() as { port: number }).port;
const port = await freePortBlock([0]); const endpoint = 'http://127.0.0.1:' + port;
const project = 'copilotbot-update-test-' + randomUUID();
const docker = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim();
const dockerHost = process.env.DOCKER_HOST ?? execFileSync(docker, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim();
const dockerRun = (args: string[]) => execFileSync(docker, args, { stdio: 'inherit' });
if (process.env.BRAIN_TEST_APP_IMAGE) {
  const image = process.env.BRAIN_TEST_APP_IMAGE;
  assert(/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*$/.test(image));
  execFileSync(docker, ['image', 'inspect', image], { stdio: 'ignore' });
  const installed = JSON.parse(execFileSync(docker, ['run', '--rm', '--network', 'none', '--entrypoint', 'cat', image, '/app/package-lock.json'], { encoding: 'utf8' }));
  const expected = JSON.parse(readFileSync(join(brain, 'package-lock.json'), 'utf8'));
  const dependencies = (lock: any) => { delete lock.version; delete lock.packages[''].version; return lock; };
  assert.deepEqual(dependencies(installed), dependencies(expected), 'Reused image must have the exact authoritative dependency lock');
  for (const directory of [previous, next, bad]) {
    for (const built of ['shared/dist', 'backend/dist', 'frontend/dist']) cpSync(join(brain, built), join(directory, built), { recursive: true });
    writeFileSync(join(directory, 'Dockerfile'), `FROM ${image}
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/ ./shared/
COPY backend/package.json ./backend/package.json
COPY backend/dist/ ./backend/dist/
COPY frontend/dist/ ./frontend/dist/
COPY migrations/ ./backend/migrations/
COPY backend/python/ ./backend/python/
COPY plugin/ ./plugin/
COPY scripts/ ./scripts/
CMD ["node", "backend/dist/server.js"]
` + (directory === bad ? 'CMD ["node", "scripts/fail-upgrade.cjs"]\n' : ''));
  }
}

if (process.env.BRAIN_TEST_MODELS_VOLUME) {
  const volume = process.env.BRAIN_TEST_MODELS_VOLUME;
  assert(/^[a-zA-Z0-9_.-]+$/.test(volume));
  for (const directory of [previous, next, bad]) {
    const file = join(directory, 'docker-compose.yml');
    const compose = readFileSync(file, 'utf8').replace('- models:/root/.ollama', '- models:/root/.ollama\n      - type: volume\n        source: shared-models\n        target: /root/.ollama/models/blobs\n        read_only: true\n        volume:\n          subpath: models/blobs');
    writeFileSync(file, compose + '\n  shared-models:\n    external: true\n    name: ' + volume + '\n');
  }
}
for (const directory of [previous, next, bad]) {
  const compose = join(directory, 'docker-compose.yml');
  writeFileSync(compose, readFileSync(compose, 'utf8').replace('LLM_PROVIDER: ${LLM_PROVIDER:-}', 'LLM_PROVIDER: stub').replace('- files:/data', '- files:/data\n      - migration-proof:/proof') + '\n  migration-proof:\n');
}
if (process.env.BRAIN_TEST_REGISTERED_MODELS_ONLY === '1') {
  for (const directory of [previous, next, bad]) writeFileSync(join(directory, 'scripts/verify-models.mjs'), `
import assert from 'node:assert/strict';
import { ensureOllamaModels } from '../backend/dist/providers/ollama.js';
import { loadConfig } from '../backend/dist/config.js';
const config = loadConfig(), models = [config.embeddingModel, config.localModel];
if (process.argv.includes('--pull')) await ensureOllamaModels(config.ollamaUrl, models);
const response = await fetch(config.ollamaUrl + '/api/tags'); assert(response.ok);
const data = await response.json();
for (const model of models) assert(data.models.some(row => row.name === model || row.name === model + ':latest'));
console.log('Registered-model check passed. Full inference remains a release CI gate.');
`);
}
for (const [version, directory] of [['0.1.0', previous], ['0.1.1', next], ['0.1.2', bad]]) {
  const path = join(workspace, version + '.tar.gz'); await tar.c({ gzip: true, file: path, cwd: directory }, ['.']);
  const bytes = readFileSync(path), id = JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8'));
  packages[version] = { bytes, manifest: { schemaVersion: 1, apiVersion: 1, ...id, archive: 'open-brain-runtime.tar.gz', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
}
const child = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, [], undefined, join(root, 'dist'), {
  endpoint, feed: feed + '/release', project, dockerBin: dirname(docker), dockerHost,
});
const runtimeLog = join(child.info.dataDir, 'open-brain/runtime.log');
let logOffset = 0;
const printRuntimeLog = () => { if (existsSync(runtimeLog)) { const bytes = readFileSync(runtimeLog); if (bytes.length > logOffset) process.stdout.write(bytes.subarray(logOffset)); logOffset = bytes.length; } };
const logWatcher = watch(dirname(runtimeLog), printRuntimeLog); printRuntimeLog();
const request = async (path: string, body?: unknown) => {
  const response = await fetch(child.info.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin: child.info.url, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert(response.ok, path + ': ' + response.status + ' ' + await response.clone().text()); return response.json() as Promise<any>;
};
const brainRequest = async (path: string, body?: unknown) => {
  const response = await fetch(endpoint + '/api/v1' + path, { method: body === undefined ? 'GET' : 'POST', ...(body instanceof FormData ? { body } : body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
  assert(response.ok, path + ': ' + response.status + ' ' + await response.clone().text()); return response.json() as Promise<any>;
};
let interrupted = false;
process.on('SIGINT', () => { interrupted = true; });
const waitFor = async (predicate: () => Promise<boolean>) => { while (!await predicate()) { if (interrupted) throw new Error('Test interrupted'); await new Promise(resolve => setTimeout(resolve, 1000)); } };
let previousStatus = '';
const status = async () => { const state = await request('/api/copilotbot/open-brain/setup'); const text = JSON.stringify(state); if (text !== previousStatus) console.log('BRAIN_STATE ' + text); previousStatus = text; return state; };
const interactive = process.argv.includes('--interactive');
const receipt: Record<string, unknown> = { project, endpoint, app: child.info.url, desktopPid: child.info.pid, modelCheck: process.env.BRAIN_TEST_REGISTERED_MODELS_ONLY === '1' ? 'registered models; full inference checked by release CI' : 'full inference', checks: [] };
const checkpoint = (name: string) => { (receipt.checks as string[]).push(name); writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(name); };
const action = async (name: string) => { console.log('ACTION ' + name + ' at ' + child.info.url); if (!interactive) await request('/api/copilotbot/open-brain/setup/' + name, {}); };
try {
  console.log('RUNTIME_LOG ' + join(child.info.dataDir, 'open-brain/runtime.log'));
  await waitFor(async () => (await status()).phase === 'not-installed');
  assert.equal((await request('/api/plugins')).plugins.length, 0);
  await action('install');
  await waitFor(async () => { const state = await status(); if (state.phase === 'error') throw new Error('Initial plugin install failed: ' + state.message); return state.phase === 'ready'; });
  assert.equal((await request('/api/plugins')).plugins[0].manifest.version, '0.1.0');
  checkpoint('installed the plugin from its own release into a desktop with no bundled Open Brain');
  const { bot } = await request('/api/bots', { name: 'Release verification' });
  await waitFor(async () => Boolean((await request('/api/copilotbot/open-brain?threadId=' + bot.threadId)).link));
  const session = (await request('/api/copilotbot/open-brain?threadId=' + bot.threadId)).link.id;
  const note = await brainRequest('/content', { type: 'note', title: 'Release note', content: 'Keep this note through updates.', session_id: session });
  const { todo } = await brainRequest('/todos', { content: 'Verify rollback keeps my work.', session_id: session });
  const file = new FormData(); const bytes = Buffer.from('Original artifact bytes retained through upgrade and rollback.');
  file.set('type', 'document'); file.set('title', 'Release artifact'); file.set('session_id', session); file.set('file', new Blob([bytes]), 'proof.txt');
  const artifact = await brainRequest('/content', file);
  receipt.ids = { session, note: note.id, todo: todo.id, artifact: artifact.id };
  const verify = async () => {
    assert.equal((await brainRequest('/content/' + note.id)).item.title, 'Release note');
    assert.equal((await brainRequest('/todos/' + todo.id)).todo.content, 'Verify rollback keeps my work.');
    const item = (await brainRequest('/content/' + artifact.id)).item;
    const downloaded = Buffer.from(await (await fetch(new URL(item.download_url, endpoint))).arrayBuffer());
    assert.deepEqual(downloaded, bytes);
    assert((await brainRequest('/sessions/' + session + '/context')).session.id === session);
  };
  await verify(); checkpoint('real Open Brain baseline records created');
  offered = '0.1.1';
  await request('/api/copilotbot/open-brain/setup/check', {});
  await waitFor(async () => (await status()).updates.available?.version === '0.1.1');
  writeFileSync(join(output, 'connection.json'), JSON.stringify({ url: child.info.url, threadId: bot.threadId, dataDir: child.info.dataDir, runtimeLog: join(child.info.dataDir, 'open-brain/runtime.log') }, null, 2));
  await action('update'); await waitFor(async () => { const state = await status(); if (state.updates.phase === 'failed') throw new Error(state.updates.message); return state.updates.current.version === '0.1.1' && !state.busy; });
  await verify();
  assert.equal((await request('/api/plugins')).plugins[0].manifest.version, '0.1.1');
  checkpoint('independent plugin upgrade retained session, note, task and exact artifact bytes on the same desktop process');
  const later = await brainRequest('/content', { type: 'note', title: 'After upgrade', content: 'Undoing rollback must recover this note.', session_id: session });
  receipt.afterUpgradeId = later.id;
  await action('rollback'); await waitFor(async () => (await status()).updates.current.version === '0.1.0' && !(await status()).busy);
  await verify(); assert.equal((await fetch(endpoint + '/api/v1/content/' + later.id)).status, 404); checkpoint('manual rollback restored the previous snapshot');
  await action('rollback'); await waitFor(async () => (await status()).updates.current.version === '0.1.1' && !(await status()).busy);
  assert.equal((await brainRequest('/content/' + later.id)).item.title, 'After upgrade'); checkpoint('undo rollback recovered the newer note');
  offered = '0.1.2'; await request('/api/copilotbot/open-brain/setup/check', {});
  await waitFor(async () => (await status()).updates.available?.version === '0.1.2');
  await action('update');
  await waitFor(async () => { const state = await status(); return state.busy || state.updates.phase === 'failed' || state.updates.current.version === '0.1.2'; });
  await waitFor(async () => { const state = await status(); if (state.busy) return false; assert.equal(state.updates.phase, 'failed', 'The failed migration must finish with automatic recovery: ' + JSON.stringify(state)); return true; });
  assert.equal(execFileSync(docker, ['compose', '--project-name', project, '--env-file', join(child.info.dataDir, 'open-brain/runtime.env'), '-f', join(previous, 'docker-compose.yml'), 'exec', '-T', 'app', 'cat', '/proof/mutated'], { encoding: 'utf8' }), 'database and files changed', 'The failed candidate must actually run its corrupting migration.');
  await verify(); assert.equal((await brainRequest('/content/' + later.id)).item.title, 'After upgrade');
  assert.equal((await status()).updates.current.version, '0.1.1'); checkpoint('failed migration automatically restored the database, files and runtime');
  process.kill(child.info.pid, 0); checkpoint('the original desktop process stayed running throughout plugin installation, update and rollback');
  if (interactive) { console.log('PROOF COMPLETE; stop the process to close the isolated fixture.'); await new Promise(resolve => process.once('SIGINT', resolve)); }
} finally {
  logWatcher.close(); printRuntimeLog();
  cpSync(join(child.info.dataDir, 'open-brain/runtime.log'), join(output, 'runtime.log'));
  try { writeFileSync(join(output, 'containers.log'), execFileSync(docker, ['compose', '--project-name', project, '-f', join(previous, 'docker-compose.yml'), '--env-file', join(child.info.dataDir, 'open-brain/runtime.env'), 'logs', '--no-color'], { encoding: 'utf8' })); } catch { /* Preserve the original test failure if container logs are unavailable. */ }
  cpSync(join(child.info.dataDir, 'open-brain/runtime.env'), join(workspace, 'cleanup.env'));
  await child.close(); releaseServer.close();
  dockerRun(['compose', '--project-name', project, '-f', join(previous, 'docker-compose.yml'), '--env-file', join(workspace, 'cleanup.env'), 'down', '--volumes']);
}
