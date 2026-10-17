import { describe, expect, it } from 'vitest';
import { selfHostedLiveAllowed, mobileVoicePatch } from './mobile.ts';
import { denyReason } from '../../companion/src/routes.ts';
import { resolveBotCreationDefaults } from '../new-bot-defaults.ts';

describe('CopilotBot mobile contract', () => {
  it('allows user-funded local voice independently of a hosted subscription', () => {
    expect(selfHostedLiveAllowed({ live: { key: 'fixture-only' } }, false)).toBe(true);
    expect(selfHostedLiveAllowed({ live: { provider: 'azure' }, azure: { endpoint: 'https://fixture.openai.azure.com', liveDeployment: 'fixture-live', auth: 'entra' } }, false)).toBe(true);
    expect(selfHostedLiveAllowed({ live: { key: 'fixture-only' } }, true)).toBe(false);
    expect(selfHostedLiveAllowed({}, false)).toBe(false);
  });
  it('exposes selected controls only after pairing and leaves credential/config routes closed', () => {
    for (const [method, path] of [
      ['GET', '/api/copilotbot/bots/bot-1/resources'], ['PUT', '/api/copilotbot/resources'],
      ['POST', '/api/copilotbot/bot-template'], ['GET', '/api/bots/bot-1/learning'],
      ['POST', '/api/bots/bot-1/learning/candidates/candidate-1/rollback'],
      ['PATCH', '/api/copilotbot/voice'], ['POST', '/api/instances/copilot/auth/start'],
    ]) {
      expect(denyReason({ path, method, authenticated: true })).toBeNull();
      expect(denyReason({ path, method, authenticated: false })?.status).toBe(401);
    }
    for (const [method, path] of [['PUT', '/api/config'], ['POST', '/api/mcp/servers'], ['POST', '/api/instances/copilot/install'], ['GET', '/api/copilotbot/bots/../../config/resources']]) {
      expect(denyReason({ path, method, authenticated: true })).not.toBeNull();
    }
    expect(mobileVoicePatch({ provider: 'azure' })).toEqual({ tts: { provider: 'azure' } });
    expect(() => mobileVoicePatch({ provider: 'azure', key: 'must-not-cross' })).toThrow();
  });
  it('uses an imported template as one validated creation transaction without altering workspace defaults', () => {
    const saved = { profile: { name: 'Default' }, memory: {}, skills: [], routines: [] };
    const imported = { profile: { name: 'Imported', skillAccess: ['research'], mcpServers: [] }, librarySkills: ['research'], routines: [], skills: [] };
    const result = resolveBotCreationDefaults(saved, { useDefaults: false, template: imported });
    expect(result.profile.name).toBe('Imported');
    expect(result.profile.mcpServers).toEqual([]);
    expect(result.librarySkills).toEqual(['research']);
    expect(saved.profile.name).toBe('Default');
    expect(() => resolveBotCreationDefaults(saved, { template: { ...imported, unknown: true } })).toThrow();
  });
});
