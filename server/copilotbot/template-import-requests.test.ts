import { expect, it, vi } from 'vitest';
import type { Store, BotRecord, Message } from '../store.ts';
import type { WireBot } from '../../shared/wire.ts';
import { TemplateImportRequests } from './template-import-requests.ts';

const yaml = (name: string) => `format: copilotbot/bot\nversion: 1\nprofile:\n  name: ${name}\n  approvalMode: full\n  chiefOfStaff: true\nroutines:\n  - name: Daily\n    prompt: Say hello\n    enabled: true\n    schedule: {type: daily, time: '09:00', weekdays: [1]}\n`;
function fixture() {
  const bots = [{ id: 'owner', name: 'Owner', section: 'Home' }] as BotRecord[];
  const messages: Message[] = [];
  const create = vi.fn(async (defaults, validateOnly) => {
    if (validateOnly) return { status: 200, body: {} };
    const bot = { id: `created-${bots.length}`, ...defaults.profile } as WireBot;
    bots.push(bot as BotRecord);
    return { status: 201, body: { bot } };
  });
  const service = new TemplateImportRequests({
    store: { bots, bot: (id: string) => bots.find(bot => bot.id === id), messagesFor: () => messages,
      appendMessage: (_thread: string, message: Message) => { const saved = { ...message, id: `msg-${messages.length}` }; messages.push(saved); return saved; },
      patchMessage: (_thread: string, id: string, patch: Partial<Message>) => { Object.assign(messages.find(message => message.id === id)!, patch); },
    } as unknown as Store,
    create, canPersist: () => ({ ok: true }), canAccessTeam: () => false,
  });
  const propose = (names = ['Alpha', 'Beta']) => service.propose('owner', 'thread', { files: names.map(name => ({ filename: `${name}.yaml`, yaml: yaml(name) })), reason: 'User asked to import these bots' });
  return { service, propose, bots, messages, create };
}
it('requires a human decision, applies all valid imports once, pauses routines and never replays permission grants', async () => {
  const f = fixture();
  const proposed = await f.propose();
  expect(proposed.state).toBe('pending');
  expect(f.bots).toHaveLength(1);
  const requestId = f.messages[0].card!.requestId!;
  const result = await f.service.resolve({ botId: 'owner', threadId: 'thread', requestId, behavior: 'allow' });
  expect(result?.request.result).toBe('applied');
  expect(f.bots).toHaveLength(3);
  expect(f.bots[1]).toMatchObject({ approvalMode: 'ask', chiefOfStaff: false, section: 'Home' });
  expect(f.create.mock.calls.filter(([, validateOnly]) => !validateOnly).every(([defaults]) => defaults.routines[0].enabled === false)).toBe(true);
  expect((await f.service.resolve({ botId: 'owner', threadId: 'thread', requestId, behavior: 'allow' }))?.duplicate).toBe(true);
  expect(f.bots).toHaveLength(3);
});
it('invalid batch, duplicate names, wrong teams and stale turns produce no bots', async () => {
  const f = fixture();
  const invalid = await f.service.propose('owner', 'thread', { files: [{ filename: 'empty.yaml', yaml: '' }, { filename: 'valid.yaml', yaml: yaml('Valid') }], reason: 'Import' });
  expect(invalid.state).toBe('preview');
  expect(f.messages).toHaveLength(0);
  await expect(f.propose(['Same', 'Same'])).rejects.toThrow('already exists');
  await expect(f.service.propose('owner', 'thread', { files: [{ filename: 'away.yaml', yaml: yaml('Away').replace('  name: Away', '  name: Away\n  section: Away') }], reason: 'Import' })).rejects.toThrow('cannot import into');
  await expect(f.service.propose('owner', 'thread', { files: [{ filename: 'A.yaml', yaml: yaml('A') }], reason: 'Import' }, undefined, () => false)).rejects.toThrow('expired');
  expect(f.bots).toHaveLength(1);
});
it('cancellation and stopped cards never create a bot', async () => {
  const f = fixture();
  await f.propose(['Alpha']);
  const requestId = f.messages[0].card!.requestId!;
  await expect(f.service.resolve({ botId: 'someone-else', threadId: 'thread', requestId, behavior: 'allow' })).rejects.toThrow('another conversation');
  expect((await f.service.resolve({ botId: 'owner', threadId: 'thread', requestId, behavior: 'deny' }))?.request.result).toBe('denied');
  await f.service.resolve({ botId: 'owner', threadId: 'thread', requestId, behavior: 'allow' });
  expect(f.bots).toHaveLength(1);
  await f.propose(['Beta']);
  f.messages[1].card!.dismissed = true;
  await f.service.resolve({ botId: 'owner', threadId: 'thread', requestId: f.messages[1].card!.requestId!, behavior: 'allow' });
  expect(f.bots).toHaveLength(1);
});
it('preserves successful receipts when a later import fails and does not duplicate on retry', async () => {
  const f = fixture();
  await f.propose();
  f.create.mockImplementation(async (defaults, validateOnly) => {
    if (!validateOnly && defaults.profile.name === 'Beta') throw new Error('Storage unavailable');
    const bot = { id: 'alpha', ...defaults.profile } as WireBot;
    return { status: 201, body: { bot } };
  });
  const args = { botId: 'owner', threadId: 'thread', requestId: f.messages[0].card!.requestId!, behavior: 'allow' };
  const result = await f.service.resolve(args);
  expect(result?.request.result).toBe('partial');
  expect(result?.request.entries.map(entry => entry.state)).toEqual(['created', 'failed']);
  await f.service.resolve(args);
  expect(f.create).toHaveBeenCalledTimes(4); // two validations and two executions
});
