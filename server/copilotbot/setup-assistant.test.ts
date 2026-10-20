import { beforeEach, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config.ts';
import { Store } from '../store.ts';
import { Roster } from './roster.ts';
import { installSetupAssistant, SETUP_ASSISTANT_TEMPLATE, SETUP_TOPICS, setupGuide } from './setup-assistant.ts';
import { parseBotTemplate } from './bot-templates.ts';

const selection = () => ({ instanceId: 'copilot', model: 'agent-default' });
beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
it('deploys the portable setup template once with a useful greeting and Ask permissions', () => {
  const store = new Store(selection);
  installSetupAssistant(store, DATA_DIR);
  expect(store.bots).toHaveLength(1);
  expect(store.bots[0]).toMatchObject({ name: 'CopilotBot Guide', approvalMode: 'ask', modelSelection: selection() });
  expect(store.messagesFor(store.bots[0].threadId)[0].text).toContain('Settings → AI → Model providers');
  const roster = new Roster(join(DATA_DIR, 'copilotbot', 'roster.json'));
  expect(parseBotTemplate(roster.botYaml(roster.read().bots[0].id)).template).toEqual(SETUP_ASSISTANT_TEMPLATE);
  expect(roster.read().deployments[0].botIds).toEqual([store.bots[0].id]);
  installSetupAssistant(new Store(selection), DATA_DIR);
  expect(new Store(selection).bots).toHaveLength(1);
  expect(roster.read().bots).toHaveLength(1);
});
it('adds the reusable template to an existing workspace without changing existing bots', () => {
  const store = new Store(selection);
  const original = store.createBot({ name: 'My assistant', soul: 'Keep me' });
  const before = structuredClone(original);
  installSetupAssistant(store, DATA_DIR);
  expect(store.bots).toEqual([before]);
  const roster = new Roster(join(DATA_DIR, 'copilotbot', 'roster.json'));
  const entry = roster.read().bots[0];
  roster.remove('bot', entry.id, entry.revision);
  installSetupAssistant(store, DATA_DIR);
  expect(roster.read().bots).toEqual([]);
});
it('provides current safe status and actionable app topics without credentials', () => {
  const guide = setupGuide('azure', { azure: { endpoint: 'https://fixture.openai.azure.com', auth: 'api-key', key: 'secret-never-return' }, decider: { key: 'another-secret' } }, [{ instanceId: 'copilot', driverKind: 'copilotAgent', state: 'missing' }]);
  expect(JSON.stringify(guide)).not.toContain('secret');
  expect(guide.status.engines[0].state).toBe('missing');
  expect(guide.guide).toContain('Sign in with Microsoft');
  expect(Object.keys(SETUP_TOPICS)).toEqual(expect.arrayContaining(['voice','decisions','resources','templates','memory','troubleshooting']));
  expect(() => setupGuide('../../credentials', {}, [])).toThrow('Unknown topic');
});
