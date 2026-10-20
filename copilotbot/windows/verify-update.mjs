import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { COPILOTBOT_UPDATE_FEED } from '../../electron/copilotbot-update-feed.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const flag = '--electron-update-fixture';
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const hash = file => createHash('sha512').update(readFileSync(file)).digest('base64');

if (process.versions.electron && process.argv.includes(flag)) {
  const { app, BrowserWindow, session } = await import('electron');
  const [preview, output, resources, installed] = process.argv.slice(process.argv.indexOf(flag) + 1);
  const origin = new URL(preview).origin;
  const target = parse(readFileSync(resolve(resources, '../..', 'latest.yml'), 'utf8'));
  const baseline = JSON.parse(readFileSync(join(installed, 'resources', 'app.asar', 'package.json'), 'utf8')).version;
  assert.notEqual(baseline, target.version, 'An actual older installation must exist');
  app.setName('CopilotBot');
  app.setPath('userData', join(output, 'user-data'));
  app.setPath('sessionData', join(output, 'user-data'));
  app.setPath('logs', join(output, 'logs'));
  app.getVersion = () => baseline;
  Object.defineProperty(app, 'isPackaged', { value: true });
  const sentinels = [join(output, 'user-data', 'saved-preferences.txt'), ...['saved-artifact.txt', 'bots.json', 'groups.json', 'messages.db'].map(name => join(output, 'workspace', name))];
  const before = sentinels.map(hash);
  const local = createRequire(import.meta.url)('../../electron/local-origin.cjs');
  local.setLocalOrigin(origin);

  void app.whenReady().then(async () => {
    let win;
    try {
      const requests = [];
      session.fromPartition('electron-updater', { cache: false }).webRequest.onBeforeRequest((details, callback) => {
        const url = new URL(details.url);
        if (url.origin === origin) return callback({});
        const prefix = `/${COPILOTBOT_UPDATE_FEED.owner}/${COPILOTBOT_UPDATE_FEED.repo}/releases`;
        assert.equal(url.origin, 'https://github.com');
        assert.ok(url.pathname.startsWith(prefix), `Unexpected release source: ${url}`);
        requests.push(url.href);
        callback({ redirectURL: `${origin}/__github${url.pathname}` });
      });
      const shippedRequire = createRequire(join(resources, 'app.asar', 'package.json'));
      const { autoUpdater, NsisUpdater } = shippedRequire('./electron/vendor/electron-updater.cjs');
      autoUpdater.updateConfigPath = join(resources, 'app-update.yml');
      autoUpdater.installDirectory = installed;
      const shippedUpdater = await import(new URL(`file:///${join(resources, 'app.asar', 'electron', 'updater.mjs').replaceAll('\\', '/')}`));
      let quitRequested = false;
      app.quit = () => { quitRequested = true; };
      let installDone, installerArguments;
      // The fixture owns relaunch so it can capture the new app's output.
      autoUpdater.spawnLog = async (command, args) => {
        installerArguments = args;
        assert.ok(args.includes('--force-run'));
        installDone = new Promise((resolveInstall, reject) => {
          const child = spawn(command, args.filter(value => value !== '--force-run'), { stdio: 'inherit' });
          child.once('error', reject);
          child.once('exit', code => code === 0 ? resolveInstall() : reject(new Error(`Installer exited ${code}`)));
        });
        return true;
      };
      shippedUpdater.registerUpdaterIpc({ pageAllowed: event => event.sender === win?.webContents && event.senderFrame === win.webContents.mainFrame });
      win = new BrowserWindow({ width: 900, height: 450, show: false, webPreferences: {
        preload: join(resources, 'app.asar', 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
        additionalArguments: [`--omb-local-origin=${origin}`],
      } });
      shippedUpdater.attachUpdaterWindow(win);
      const evaluate = value => win.webContents.executeJavaScript(value, true);
      const waitFor = async predicate => { while (!await predicate()) await new Promise(resolveWait => setTimeout(resolveWait, 100)); };
      const text = () => evaluate('document.body.innerText');
      const click = label => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!button || button.disabled) throw Error('Missing enabled update button'); button.click(); })()`);
      await win.loadURL(preview);
      await waitFor(async () => (await text()).includes('Check for updates'));
      await evaluate('window.ogb.updater.onState(state => { window.__updateProof = state; })');
      shippedUpdater.startUpdater();
      assert.equal(autoUpdater.allowPrerelease, false);
      assert.equal(autoUpdater.allowDowngrade, false);
      assert.equal(autoUpdater.autoInstallOnAppQuit, false);
      writeFileSync(join(output, 'check-for-updates.png'), (await win.webContents.capturePage()).toPNG());
      await click('Check for updates');
      await waitFor(async () => {
        const value = await text();
        if (await evaluate('window.__updateProof?.status === "error"')) throw new Error(value);
        return value.includes('Restart and install');
      });
      assert.ok((await text()).includes(target.version));
      assert.equal(quitRequested, false);
      assert.equal(hash(autoUpdater.installerPath), target.files[0].sha512);
      assert.ok(requests.some(url => url.endsWith('/releases/latest')));
      assert.ok(requests.some(url => url.endsWith('/latest.yml')));
      writeFileSync(join(output, 'restart-and-install.png'), (await win.webContents.capturePage()).toPNG());
      await click('Restart and install');
      await waitFor(() => Boolean(installDone && quitRequested));
      await installDone;
      assert.deepEqual(sentinels.map(hash), before);
      const actual = JSON.parse(readFileSync(join(installed, 'resources', 'app.asar', 'package.json'), 'utf8')).version;
      assert.equal(actual, target.version);
      for (const version of [target.version, '99.0.0']) {
        app.getVersion = () => version;
        const probe = new NsisUpdater(COPILOTBOT_UPDATE_FEED);
        probe.updateConfigPath = join(resources, 'app-update.yml');
        probe.setFeedURL(COPILOTBOT_UPDATE_FEED);
        probe.allowPrerelease = false;
        probe.allowDowngrade = false;
        assert.equal((await probe.checkForUpdates()).isUpdateAvailable, false);
      }
      const receipt = { installationPassed: true, sourceVersion: baseline, targetVersion: actual, preservedFiles: sentinels.map((file, index) => ({ file, sha512: before[index] })), requests, installerArguments,
        flow: 'Shipped Settings update row and preload → production updater → GitHub provider → verified installer → in-place NSIS install',
        limitation: 'GitHub responses use a local release fixture; relaunch is captured separately by the workflow.' };
      writeFileSync(join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
      console.log(JSON.stringify(receipt));
      win.destroy();
      app.exit(0);
    } catch (error) { console.error(error); win?.destroy(); app.exit(1); }
  });
} else {
  assert.equal(process.platform, 'win32', 'Run the native updater acceptance on Windows');
  const resources = resolve(option('resources'));
  const installed = resolve(option('installed'));
  const output = resolve(option('output'));
  const release = resolve(resources, '../..');
  const target = parse(readFileSync(join(release, 'latest.yml'), 'utf8'));
  const feed = parse(readFileSync(join(resources, 'app-update.yml'), 'utf8'));
  for (const [key, value] of Object.entries(COPILOTBOT_UPDATE_FEED)) assert.equal(feed[key], value);
  const installer = join(release, target.files[0].url);
  assert.equal(hash(installer), target.files[0].sha512);
  assert.ok(existsSync(`${installer}.blockmap`));
  for (const folder of ['home', 'user-data', 'workspace', 'logs']) mkdirSync(join(output, folder), { recursive: true });
  writeFileSync(join(output, 'user-data', 'saved-preferences.txt'), 'Existing desktop preferences\n');
  writeFileSync(join(output, 'workspace', 'saved-artifact.txt'), 'Existing bot artifact\n');
  const isolatedEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '', HOME: join(output, 'home'), USERPROFILE: join(output, 'home'), APPDATA: join(output, 'user-data'), LOCALAPPDATA: join(output, 'user-data'), OMB_DATA_DIR: join(output, 'workspace'), OMB_OPEN_BRAIN_ENABLED: '0' };
  const workspaceServer = async () => {
    const { createServer: socketServer } = await import('node:net');
    const socket = socketServer();
    await new Promise(done => socket.listen(0, '127.0.0.1', done));
    const port = socket.address().port;
    await new Promise(done => socket.close(done));
    const processServer = spawn(process.execPath, [join(installed, 'resources', 'server', 'index.js')], { env: { ...isolatedEnv, OMB_PORT: String(port), OMB_RESOURCES_PATH: join(installed, 'resources') }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise(done => processServer.once('close', done));
    for (const stream of [processServer.stdout, processServer.stderr]) stream.on('data', data => appendFileSync(join(output, 'workspace-server.log'), data));
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    while (!ready) {
      if (processServer.exitCode !== null) throw new Error('Preservation fixture server exited before ready');
      try { ready = (await fetch(`${base}/api/health`)).ok; } catch {}
      if (!ready) await new Promise(done => setTimeout(done, 100));
    }
    return {
      async api(method, path, body) {
        const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', origin: base }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await response.json();
        assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
        return data;
      },
      async close() { processServer.kill(); await exited; },
    };
  };
  const beforeServer = await workspaceServer();
  let preserved;
  try {
    const { bot } = await beforeServer.api('POST', '/api/bots', { name: 'Update preservation bot' });
    const { task } = await beforeServer.api('POST', `/api/bots/${bot.id}/tasks`, { title: 'Keep this thread' });
    const { group } = await beforeServer.api('POST', '/api/groups', { name: 'Update preservation team', memberIds: [bot.id], setup: { bulletin: 'Keep this team briefing', defaultResponder: { kind: 'member', botId: bot.id } } });
    await beforeServer.api('PUT', `/api/bots/${bot.id}/memory/file`, { path: 'memory/retained.md', text: 'Keep this useful note after updating.\n', expectedHash: createHash('sha256').update('').digest('hex') });
    preserved = { botId: bot.id, threadId: task.threadId, groupId: group.id };
  } finally { await beforeServer.close(); }
  const { createServer } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const { default: tailwindcss } = await import('@tailwindcss/vite');
  const prefix = `/${COPILOTBOT_UPDATE_FEED.owner}/${COPILOTBOT_UPDATE_FEED.repo}/releases`;
  const ui = await createServer({ configFile: false, root, resolve: { alias: { '@': join(root, 'src') } }, define: { __APP_VERSION__: JSON.stringify(target.version) }, server: { host: '127.0.0.1', port: 0 }, plugins: [react(), tailwindcss(), {
    name: 'copilotbot-update-fixture',
    resolveId(id) { if (id === 'virtual:update-fixture') return `\0${id}`; },
    load(id) { if (id === '\0virtual:update-fixture') return `import React from 'react'; import { createRoot } from 'react-dom/client'; import { UpdatesRow } from '/src/components/SettingsModal.tsx'; import { setLocale } from '/src/lib/i18n.ts'; import { applyBrand } from '/src/lib/brand.ts'; import '/src/styles.css'; setLocale('en'); applyBrand({brand:{name:'CopilotBot'},source:'default',file:''}); createRoot(document.getElementById('root')).render(React.createElement('main',{className:'mx-auto max-w-2xl p-8'},React.createElement('h1',null,'CopilotBot updates'),React.createElement(UpdatesRow)));`; },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      const pathname = new URL(req.url, 'http://fixture').pathname;
      if (pathname === '/__update.html') return void server.transformIndexHtml(pathname, '<html><head><title>CopilotBot update acceptance</title></head><body class="bg-app"><div id="root"></div><script type="module" src="/@id/virtual:update-fixture"></script></body></html>').then(html => { res.setHeader('content-type', 'text/html'); res.end(html); }).catch(next);
      if (!pathname.startsWith('/__github')) return next();
      const route = pathname.slice('/__github'.length);
      if (route === `${prefix}.atom`) { res.setHeader('content-type', 'application/atom+xml'); return res.end(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>CopilotBot ${target.version}</title><link href="https://github.com${prefix}/tag/v${target.version}"/><content>Fixture release</content></entry></feed>`); }
      if (route === `${prefix}/latest`) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ tag_name: `v${target.version}` })); }
      const name = route.slice(`${prefix}/download/v${target.version}/`.length);
      if (route.startsWith(`${prefix}/download/v${target.version}/`) && ['latest.yml', target.files[0].url, `${target.files[0].url}.blockmap`].includes(name)) {
        const file = join(release, name);
        res.setHeader('content-length', statSync(file).size);
        return createReadStream(file).pipe(res);
      }
      res.statusCode = 404; res.end('No fixture release asset');
    }); },
  }] });
  try {
    await ui.listen();
    const preview = `${ui.resolvedUrls.local[0]}__update.html`;
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), flag, preview, output, resources, installed], { stdio: 'inherit', env: isolatedEnv });
    const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
    assert.equal(code, 0, `Windows updater acceptance failed; evidence: ${output}`);
    const afterServer = await workspaceServer();
    try {
      const data = await afterServer.api('GET', '/api/bots?messages=0');
      assert.ok(data.bots.some(bot => bot.id === preserved.botId && bot.name === 'Update preservation bot'));
      assert.ok(data.groups.some(group => group.id === preserved.groupId && group.memberIds.includes(preserved.botId)));
      const tasks = await afterServer.api('GET', `/api/bots/${preserved.botId}/tasks`);
      assert.ok(tasks.tasks.some(task => task.threadId === preserved.threadId && task.title === 'Keep this thread'));
      const note = await afterServer.api('GET', `/api/bots/${preserved.botId}/memory/file?path=memory%2Fretained.md`);
      assert.equal(note.text, 'Keep this useful note after updating.\n');
      const receiptPath = join(output, 'receipt.json');
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      writeFileSync(receiptPath, `${JSON.stringify({ ...receipt, passed: true, persistedWorkspace: { ...preserved, noteRestored: true } }, null, 2)}\n`);
    } finally { await afterServer.close(); }
  } finally { await ui.close(); }
}
