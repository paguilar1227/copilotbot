import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DATA_DIR } from '../config.ts';
import { ResourcePolicies, intersectResources } from './resource-access.ts';

describe('bot and team resource limits', () => {
  it('intersects allowlists and preserves unrestricted versus empty', () => {
    expect(intersectResources(null, null)).toBeNull();
    expect(intersectResources(['a', 'b'], ['b', 'c'])).toEqual(['b']);
    expect(intersectResources([], null)).toEqual([]);
    expect(intersectResources(null, ['a'])).toEqual(['a']);
  });
  it('inherits on new members, keeps team identity through renames, and persists', () => {
    const keys: Record<string, string> = { Research: 'team-1' };
    const file = join(DATA_DIR, 'resources-test.json');
    const policies = new ResourcePolicies(file, name => keys[name ?? ''] ?? name ?? '');
    policies.setTeam('Research', { skills: ['research'], mcpServers: ['search'] });
    expect(policies.effective({ section: 'Research', mcpServers: ['search', 'notes'] })).toEqual({ skills: ['research'], mcpServers: ['search'] });
    keys.Analysis = keys.Research!; delete keys.Research;
    expect(new ResourcePolicies(file, name => keys[name ?? ''] ?? '').team('Analysis').skills).toEqual(['research']);
    keys.Research = 'team-2';
    expect(policies.team('Research')).toEqual({ skills: null, mcpServers: null });
  });
  it('does not silently grant access when saved policy is damaged', () => {
    mkdirSync(DATA_DIR, { recursive: true });
    const file = join(DATA_DIR, 'resources-invalid.json'); writeFileSync(file, '{bad');
    expect(() => new ResourcePolicies(file, name => name ?? '').effective({})).toThrow();
  });
});
