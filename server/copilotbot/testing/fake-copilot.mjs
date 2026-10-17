#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { appendFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
function resources() {
  const data = process.env.FAKE_COPILOT_CATALOG ? JSON.parse(readFileSync(process.env.FAKE_COPILOT_CATALOG, 'utf8')) : { skills: [], mcpServers: {} };
  const settingsPath = join(process.env.COPILOT_HOME || join(process.env.HOME, '.copilot'), 'settings.json');
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  return {
    skills: data.skills.map(row => ({ ...row, enabled: row.enabled !== false && !(settings.disabledSkills ?? []).includes(row.name) })),
    mcpServers: Object.fromEntries(Object.entries(data.mcpServers).map(([name, row]) => [name, { ...row, enabled: row.enabled !== false && !(settings.disabledMcpServers ?? []).includes(name) }])),
  };
}
if (['skill', 'mcp'].includes(process.argv[2]) && process.argv[3] === 'list') {
  const catalog = resources();
  const output = process.argv[2] === 'skill' ? catalog.skills : { mcpServers: catalog.mcpServers };
  await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(output) + '\n', error => error ? reject(error) : resolve()));
  process.exit(0);
}
const authPath = process.env.HOME + '/copilot-authenticated';
if (process.argv.includes('--version')) { console.log('Copilot CLI 1.0.98 fixture'); process.exit(0); }
if (process.argv.includes('login')) {
  console.error('First copy your one-time code: ABCD-EFGH');
  console.error('Open https://github.com/login/device');
  await new Promise(resolve => setTimeout(resolve, 100));
  writeFileSync(authPath, 'fixture-only');
  process.exit(0);
}
let model = 'fixture-gpt', effort = 'low', sessionId = 'fixture-session';
const models = [
  { value: 'fixture-gpt', name: 'Fixture GPT' },
  { value: 'fixture-claude', name: 'Fixture Claude' },
];
const snapshot = () => ({ sessionId, configOptions: [
  { id: 'model', type: 'select', currentValue: model, options: models },
  { id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: effort,
    options: ['none', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ value, name: value })) },
] });
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line), p = message.params ?? {};
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: 1, agentInfo: { name: 'Fake Copilot', version: 'fixture' },
    agentCapabilities: { loadSession: true }, authMethods: [] };
  else if (message.method === 'session/new' || message.method === 'session/load') {
    if (!existsSync(authPath)) { send({id:message.id,error:{code:-32000,message:'Login required'}}); return; }
    sessionId = p.sessionId ?? sessionId; result = snapshot();
  } else if (message.method === 'session/set_config_option') {
    if (p.configId === 'model') model = p.value;
    if (p.configId === 'reasoning_effort') effort = p.value;
    result = snapshot();
  } else if (message.method === 'session/prompt') {
    const text = `NATIVE_EFFORT_OK:${model}:${effort}`;
    if (process.env.FAKE_COPILOT_RECEIPTS) appendFileSync(process.env.FAKE_COPILOT_RECEIPTS, JSON.stringify({ model, effort, ...(process.env.FAKE_COPILOT_CATALOG ? { resources: resources(), copilotHome: process.env.COPILOT_HOME } : {}) }) + '\n');
    send({ method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
    } } });
    result = { stopReason: 'end_turn' };
  } else result = {};
  send({ id: message.id, result });
});
