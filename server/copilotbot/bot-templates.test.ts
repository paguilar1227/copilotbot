import { describe, expect, it } from 'vitest';
import { exportBotTemplate, parseBotTemplate } from './bot-templates.ts';
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
