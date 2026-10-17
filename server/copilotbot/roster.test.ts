import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { Roster } from './roster.ts';
import { parseBotTemplate } from './bot-templates.ts';
import type { TeamTemplateDefinition } from '../../shared/roster.ts';

const bot = parseBotTemplate('format: copilotbot/bot\nversion: 1\nprofile:\n  name: Researcher\n').template;
const team = (members: string[]): TeamTemplateDefinition => ({ name: 'Research', description: '', members, resources: { skills: [], mcpServers: [] }, instructions: 'Check sources.', peers: {}, rooms: [] });
function fixture() { const path = join(mkdtempSync(join(tmpdir(), 'roster-test-')), 'roster.json'); return { path, roster: new Roster(path) }; }

describe('saved roster', () => {
  it('persists definitions and prevents deleting referenced bots until every team releases them', () => {
    const { path, roster } = fixture();
    const saved = roster.saveBot(bot);
    const first = roster.saveTeam(team([saved.id]));
    const second = roster.saveTeam({ ...team([saved.id]), name: 'Review' });
    expect(() => roster.remove('bot', saved.id, saved.revision)).toThrow('Research, Review');
    roster.remove('team', first.id, first.revision);
    expect(() => roster.remove('bot', saved.id, saved.revision)).toThrow('Review');
    roster.remove('team', second.id, second.revision);
    roster.remove('bot', saved.id, saved.revision);
    expect(new Roster(path).read().bots).toEqual([]);
  });
  it('rejects stale edits, missing references, and malformed snapshots without losing saved data', () => {
    const { path, roster } = fixture(); const saved = roster.saveBot(bot);
    roster.saveBot({ ...bot, profile: { ...bot.profile, name: 'Edited' } }, saved.id, saved.revision);
    expect(() => roster.saveBot(bot, saved.id, saved.revision)).toThrow('changed');
    const before = readFileSync(path, 'utf8');
    expect(() => roster.saveTeam(team(['00000000-0000-4000-8000-000000000000']))).toThrow('no longer exists');
    expect(() => roster.captureTeam([bot], () => team([]))).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(before);
    writeFileSync(path, '{broken');
    expect(() => roster.saveBot(bot)).toThrow('could not be read');
    expect(readFileSync(path, 'utf8')).toBe('{broken');
  });
});
