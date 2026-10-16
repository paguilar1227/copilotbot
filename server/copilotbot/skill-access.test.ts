import { afterEach, expect, it, vi } from 'vitest';
import { configureResourceAccess } from './resource-access.ts';
import { createSkillsLibraryHost } from '../host/skills-library.ts';
import { prepareShareNote } from '../skill-share.ts';
import type { BotRecord, Store } from '../store.ts';
import type { AppConfig } from '../config.ts';

vi.mock('../skill-share.ts', async original => ({
  ...await original<typeof import('../skill-share.ts')>(),
  prepareShareNote: vi.fn((_bot, _thread, assigned: string[]) => ({ text: assigned.join(','), commit: vi.fn() })),
}));
afterEach(() => { configureResourceAccess(() => ({ skills: null, mcpServers: null })); vi.clearAllMocks(); });

it('filters new shared-skill announcements through the same effective policy as the prompt index', () => {
  configureResourceAccess(() => ({ skills: ['allowed'], mcpServers: null }));
  const bot = { id: 'fixture-bot', assignedSkills: ['allowed', 'denied'] } as BotRecord;
  const host = createSkillsLibraryHost({
    store: { bot: () => bot, messagesFor: () => [{ at: 1 }] } as unknown as Store,
    cfg: { features: { skillsLibrary: true } } as AppConfig,
    appendSkillRequestCard: vi.fn(),
  });
  expect(host.shareNote(bot, 'thread', true).text).toBe('allowed');
  expect(prepareShareNote).toHaveBeenCalledWith(bot.id, 'thread', ['allowed'], 1, []);
  expect(host.editable(bot.id, 'denied')).toBe(false);
});
