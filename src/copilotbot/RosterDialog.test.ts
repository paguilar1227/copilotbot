// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RosterDialog } from './RosterDialog';
import type { RosterSummary } from '../../shared/roster';

const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/state/store', () => ({ api: mock.api, useStore: () => ({ state: { bots: [] } }) }));
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root?.unmount()); document.body.innerHTML = ''; mock.api.mockReset(); });
const entry = (id: string, name: string, kind: 'bot' | 'team' = 'bot'): RosterSummary => ({ id, name, kind, description: '', revision: 1, memberCount: 1, usedBy: [], activeCopies: 0 });
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => (button.getAttribute('aria-label') ?? button.textContent) === name)!;
async function click(name: string) { await act(async () => button(name).click()); }
async function fill(label: string, text: string) {
  const input = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function render() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(RosterDialog, { onClose: vi.fn() })));
}
it('searches a large roster while preserving selections and reuses a failed deployment request ID', async () => {
  const entries = Array.from({ length: 200 }, (_, i) => entry(`id-${i}`, `Specialist ${i}`));
  let failed = false;
  mock.api.mockImplementation(async (path: string) => {
    if (path.endsWith('/deploy')) { if (!failed) { failed = true; throw new Error('Temporary network issue'); } return { deployments: [{}] }; }
    return { entries };
  });
  await render();
  await act(async () => document.querySelector<HTMLInputElement>('[aria-label="Deploy Specialist 0"]')!.click());
  await fill('Search roster', 'Specialist 199');
  await act(async () => document.querySelector<HTMLInputElement>('[aria-label="Deploy Specialist 199"]')!.click());
  expect(document.body.textContent).toContain('2 selected · 200 saved');
  await click('Deploy selected (2)');
  expect(document.body.textContent).toContain('Temporary network issue');
  await click('Deploy selected (2)');
  const calls = mock.api.mock.calls.filter(([path]) => path.endsWith('/deploy'));
  const bodies = calls.map(([, options]) => JSON.parse(options.body));
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0].selections.map((item: { id: string }) => item.id)).toEqual(['id-0', 'id-199']);
  expect(document.body.textContent).toContain('Deployed 1 template');
});
it('renders the saved avatar image with its crop and shows member previews for teams', async () => {
  const portrait = { name: 'Portrait', color: 'blue' as const, avatarUrl: '/api/attachments/portrait.png', avatarCrop: 'rounded' as const, avatarZoom: 2 };
  const alpha = { ...entry('alpha', 'Portrait'), avatars: [portrait] };
  const team = { ...entry('team', 'Research', 'team'), avatars: [portrait, { name: 'Star', color: 'purple' as const, mascotBody: 'star' as const }], memberCount: 2 };
  mock.api.mockResolvedValue({ entries: [alpha, team] });
  await render();
  const images = document.querySelectorAll<HTMLImageElement>('img[src="/api/attachments/portrait.png"]');
  expect(images).toHaveLength(2);
  expect(images[0].loading).toBe('lazy');
  expect(images[0].style.transform).toBe('scale(2)');
  expect(document.querySelector('[aria-label="Research appearance"] svg')).not.toBeNull();
});
it('explains deletion blockers and removes deleted team members from peer and chat setup when edited', async () => {
  const alpha = entry('alpha', 'Alpha'), beta = entry('beta', 'Beta'), team = entry('team', 'Research', 'team');
  alpha.usedBy = [{ id: team.id, name: team.name }];
  const definition = { name: 'Research', description: '', members: ['alpha', 'beta'], instructions: '', resources: { skills: [], mcpServers: [] }, peers: { beta: ['alpha'] }, rooms: [{ name: 'Alpha room', members: ['alpha'], bulletin: '', responder: { kind: 'member', botId: 'alpha' } }] };
  mock.api.mockImplementation(async (path: string, options?: { method: string; body: string }) => {
    if (path.endsWith('/teams/team') && !options) return { ...team, definition };
    return { entries: [alpha, beta, team] };
  });
  await render(); await click('Delete Alpha');
  expect(document.body.textContent).toContain('Used by team templates: Research');
  expect(mock.api.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
  await click('Edit Research');
  const checkbox = [...document.querySelectorAll<HTMLLabelElement>('label')].find(label => label.textContent?.includes('Alpha'))!.querySelector<HTMLInputElement>('input')!;
  await act(async () => checkbox.click());
  await click('Save team template');
  const request = mock.api.mock.calls.find(([, options]) => options?.method === 'PUT')!;
  const saved = JSON.parse(request[1].body).definition;
  expect(saved.members).toEqual(['beta']); expect(saved.rooms).toEqual([]); expect(saved.peers).toEqual({ beta: [] });
});
