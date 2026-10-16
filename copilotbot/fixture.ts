import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { launchVerificationServer, runControlOmb } from '../scripts/control-omb.ts';

const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, resolve('dist'));
const fake = fileURLToPath(new URL('../server/copilotbot/testing/fake-copilot.mjs', import.meta.url));
await fetch(fixture.info.url + '/api/instances/copilot', {
  method: 'PATCH', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cli: `${JSON.stringify(process.execPath)} ${JSON.stringify(fake)}` }),
});
await runControlOmb(['new-bot', '--name', 'CopilotBot preview', '--url', fixture.info.url]);
console.log(JSON.stringify(fixture.info));
const close = () => void fixture.close().then(() => process.exit(0));
process.once('SIGINT', close);
process.once('SIGTERM', close);
