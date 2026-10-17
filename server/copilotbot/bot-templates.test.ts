import { describe, expect, it } from 'vitest';
import { exportBotTemplate, parseBotTemplate, previewBotTemplates } from './bot-templates.ts';
import type { BotRecord } from '../store.ts';

const bot = { id: 'private-id', threadId: 'private-thread', name: 'Researcher', title: 'Analyst', description: 'Research products',
  soul: 'Use sources.\nExplain clearly.', color: 'blue', notifications: false, modelSelection: { instanceId: 'copilot', model: 'gpt', effort: 'high' },
  computer: 'off', approvalMode: 'ask', voice: 'alloy', speakReplies: true, voiceNotes: false, replyStyle: 'conversational',
  memoryEnabled: false, memoryUpkeep: false, recordBrowserSteps: false, helperModel: false,
  approvalGrant: 'DO-NOT-EXPORT', connectorTools: { secret: { key: 'DO-NOT-EXPORT' } }, peers: ['private-bot'],
  avatarUrl: '/api/attachments/private-image.png', assignedSkills: ['research'], createdAt: 123,
} as unknown as BotRecord;

describe('portable YAML bot templates', () => {
  it('round trips reusable bot options, model effort, voice and resources without runtime identity or grants', () => {
    const resources = { skills: ['research'], mcpServers: ['search'] };
    const yaml = exportBotTemplate(bot, resources, [{ id: 'private-routine', botId: bot.id, name: 'Daily review', prompt: 'Review sources', enabled: false, schedule: { type: 'daily', time: '09:00', weekdays: [1] }, attachments: [{ path: 'private-file' }] }]);
    const result = parseBotTemplate(yaml);
    expect(result.template.resources).toEqual(resources);
    expect(result.defaults.profile).toMatchObject({ name: bot.name, soul: bot.soul, modelSelection: bot.modelSelection, voiceNotes: false, memoryEnabled: false, skillAccess: ['research'], mcpServers: ['search'] });
    expect(result.defaults.routines[0]).toMatchObject({ name: 'Daily review', enabled: false });
    for (const forbidden of ['private-id', 'private-thread', 'DO-NOT-EXPORT', 'private-bot', 'private-image', 'private-file', 'private-routine']) expect(yaml).not.toContain(forbidden);
    expect(result.defaults.memory).toEqual({});
    expect(result.defaults.skills).toEqual([]);
  });
  it.each([
    'format: copilotbot/bot\nversion: 2',
    'format: copilotbot/bot\nversion: 1\nprofile:\n  acknowledgeLocalAuto: true',
    'format: copilotbot/bot\nversion: 1\nprofile:\n  peers: [someone]',
    'format: copilotbot/bot\nversion: 1\nresources:\n  mcpServers: [{command: sh}]',
    'format: copilotbot/bot\nversion: 1\nprofile:\n  name: &n secret\n  title: *n',
    'format: copilotbot/bot\nversion: 1\nversion: 1',
    'format: copilotbot/bot\nversion: 1\nprofile: !unknown {}',
  ])('rejects unsupported or executable configuration: %s', yaml => { expect(() => parseBotTemplate(yaml)).toThrow(); });
  it('keeps all and none distinct', () => {
    for (const value of [null, []]) expect(parseBotTemplate(exportBotTemplate(bot, { skills: value, mcpServers: value })).template.resources).toEqual({ skills: value, mcpServers: value });
  });
});

it('reports missing required identity, wrong types and malformed YAML per document without creating defaults', () => {
  const files = [
    { filename: 'missing.yaml', yaml: 'format: copilotbot/bot\nversion: 1\nprofile: {}' },
    { filename: 'types.yaml', yaml: 'format: copilotbot/bot\nversion: 1\nprofile:\n  name: 123' },
    { filename: 'broken.yaml', yaml: 'profile: [unfinished' },
    { filename: 'empty.yaml', yaml: '' },
  ];
  const result = previewBotTemplates(files);
  expect(result).toHaveLength(4);
  expect(result.every(item => !item.defaults && item.diagnostics.length)).toBe(true);
  expect(result[0].diagnostics[0].path).toBe('profile.name');
  expect(result[1].diagnostics[0]).toMatchObject({ path: 'profile.name', line: 4 });
  expect(result[2].diagnostics[0].line).toBeDefined();
});
it('keeps valid documents on both sides of an invalid document and preserves order across files', () => {
  const one = exportBotTemplate({ ...bot, name: 'One' }, { skills: [], mcpServers: [] });
  const two = exportBotTemplate({ ...bot, name: 'Two' }, { skills: null, mcpServers: null });
  const result = previewBotTemplates([{ filename: 'batch.yaml', yaml: `${one}---\nformat: copilotbot/bot\nversion: 1\nprofile: {}\n---\n${two}` }, { filename: 'last.yaml', yaml: one }]);
  expect(result.map(item => item.defaults?.profile.name)).toEqual(['One', undefined, 'Two', 'One']);
  expect(result.map(item => item.document)).toEqual([1, 2, 3, 1]);
  expect(new Set(result.map(item => item.id)).size).toBe(4);
});
it('never resolves aliases, tags, executable configuration or unknown fields in a batch', () => {
  for (const yaml of ['format: copilotbot/bot\nversion: 1\nprofile: &p {name: A}\nresources: *p', '!!js/function function() {}', 'format: copilotbot/bot\nversion: 1\nprofile: {name: A}\nsecrets: {key: hidden}']) {
    expect(previewBotTemplates([{ filename: 'unsafe.yaml', yaml }])[0].defaults).toBeUndefined();
  }
});
