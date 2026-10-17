import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { WorkspaceProjects } from './workspace-projects.ts';

it('persists project membership and collapse, moves members exclusively, and rejects stale writes', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'workspace-projects-')), 'projects.json');
  const store = new WorkspaceProjects(file), bot = randomUUID();
  const first = store.save({ name: 'Product', teamIds: ['team-a'], botIds: [bot, bot] });
  expect(first.botIds).toEqual([bot]);
  const collapsed = store.collapse(first.id, true, 1);
  expect(new WorkspaceProjects(file).list()).toEqual([collapsed]);
  expect(() => store.save({ name: 'Stale' }, first.id, 1)).toThrow('changed');
  const second = store.save({ name: 'Engineering', teamIds: ['team-a'], botIds: [bot] });
  expect(store.list()[0]).toMatchObject({ id: first.id, revision: 3, teamIds: [], botIds: [], collapsed: true });
  expect(() => store.save({ name: 'engineering' })).toThrow('already exists');
  store.remove(second.id, second.revision);
  expect(store.list()).toHaveLength(1);
  writeFileSync(file, '{bad');
  expect(() => store.save({ name: 'Unsafe' })).toThrow('could not be read');
  expect(readFileSync(file, 'utf8')).toBe('{bad');
});
