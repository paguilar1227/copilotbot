// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceProjectDialog, WorkspaceProjectSection } from './WorkspaceProjects';
import type { Bot } from '@/state/store';
import { projectStandaloneBots, type WorkspaceProject } from '../../shared/workspace-projects';

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root?.unmount()); document.body.innerHTML = ''; });
function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement('div'); document.body.append(element); root = createRoot(element); return element;
}
const project: WorkspaceProject = { id: 'a', name: 'Release', revision: 1, collapsed: false, teamIds: ['team-0'], botIds: ['bot-0'] };
it('keeps selected members across large-catalog searches and submits all selections', async () => {
  setup(); const save = vi.fn().mockResolvedValue(true), close = vi.fn();
  const teams = Array.from({ length: 150 }, (_, i) => ({ id: `team-${i}`, name: `Team ${i}` }));
  const bots = Array.from({ length: 300 }, (_, i) => ({ id: `bot-${i}`, name: `Bot ${i}`, hidden: false })) as Bot[];
  bots.push({ id: 'member', name: 'Team member', section: 'Team 0' } as Bot);
  await act(async () => root!.render(createElement(WorkspaceProjectDialog, { project, catalog: { projects: [project], teams }, bots, pending: false, error: '', onSave: save, onRemove: vi.fn(), onClose: close })));
  expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(450);
  expect(document.querySelector('[aria-label="Include bot Team member"]')).toBeNull();
  const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '149'); search.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => document.querySelector<HTMLInputElement>('[aria-label="Include team Team 149"]')!.click());
  expect(document.body.textContent).toContain('Teams · 2 selected');
  expect(document.body.textContent).toContain('Individual bots · 1 selected');
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Save project')!.click());
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ teamIds: ['team-0', 'team-149'], botIds: ['bot-0'], revision: 1 }));
  expect(close).toHaveBeenCalledOnce();
});
it('collapses only project contents and keeps the accessible divider and edit action', async () => {
  const container = setup();
  const props = { project, count: 2, pending: false, compact: false, onToggle: vi.fn(), onEdit: vi.fn(), children: createElement('div', null, 'Inside team') };
  await act(async () => root!.render(createElement(WorkspaceProjectSection, { ...props, expanded: false })));
  expect(container.textContent).not.toContain('Inside team');
  expect(container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
  await act(async () => root!.render(createElement(WorkspaceProjectSection, { ...props, expanded: true })));
  expect(container.textContent).toContain('Inside team');
  expect(container.querySelector('button[aria-label="Edit project Release"]')).not.toBeNull();
});

it('project membership includes pinned bots but excludes hidden bots and team members', () => {
  const value = { ...project, botIds: ['pinned', 'hidden', 'member'] };
  expect(projectStandaloneBots(value, [
    { id: 'pinned', pinned: true }, { id: 'hidden', hidden: true }, { id: 'member', section: 'Design' },
  ])).toEqual([{ id: 'pinned', pinned: true }]);
});
