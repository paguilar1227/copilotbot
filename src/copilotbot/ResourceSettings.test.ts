// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Bot } from '@/state/store';
import type { ResourceState } from '../../shared/bot-resources';
import { ResourceSettings } from './ResourceSettings';

const fixture = vi.hoisted(() => ({ request: vi.fn(), bots: [] as Array<{ id: string; section: string; busy: boolean }> }));
vi.mock('@/state/store', () => ({ api: fixture.request, useStore: () => ({ state: { bots: fixture.bots } }) }));
vi.mock('@/components/bot-settings/BotEditorContext', () => ({ useBotEditor: () => ({ request: fixture.request }) }));
vi.mock('@/components/Select', () => ({ Select: (props: object) => createElement('select', props) }));
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root?.unmount()); document.body.innerHTML = ''; fixture.request.mockReset(); });

it.each(['bot', 'team'])('unlocks %s controls when work stops without reopening settings', async mode => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.bots = [{ id: 'bot', section: 'team', busy: true }];
  fixture.request.mockResolvedValue({ policy: { skills: null, mcpServers: null }, inherited: { skills: null, mcpServers: null }, effective: { skills: null, mcpServers: null }, catalog: { skills: [], mcpServers: [] }, busy: true });
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const render = () => createElement(ResourceSettings, mode === 'bot' ? { bot: fixture.bots[0] as Bot } : { team: 'team' });
  await act(async () => root!.render(render()));
  expect(container.querySelector('select')?.disabled).toBe(true);
  expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.disabled).toBe(false);
  fixture.bots = [{ ...fixture.bots[0]!, busy: false }];
  await act(async () => root!.render(render()));
  expect(container.querySelector('select')?.disabled).toBe(false);
});

async function renderCatalog(mode: string, data: ResourceState) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.bots = [{ id: 'bot', section: 'team', busy: false }];
  fixture.request.mockImplementation(async (_path: string, options?: { body: string }) => {
    if (options) data.policy = JSON.parse(options.body);
    return { ...data };
  });
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(createElement(ResourceSettings, mode === 'bot' ? { bot: fixture.bots[0] as Bot } : { team: 'team' })));
  return container;
}

async function search(container: HTMLElement, label: string, text: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function catalog(): ResourceState {
  return {
    policy: { skills: null, mcpServers: null }, inherited: { skills: null, mcpServers: null },
    effective: { skills: null, mcpServers: null }, busy: false,
    catalog: {
      skills: Array.from({ length: 1000 }, (_, i) => ({ name: `workflow-${i}`, enabled: true, description: i === 999 ? 'Unique deployment review' : 'General workflow' })),
      mcpServers: Array.from({ length: 200 }, (_, i) => ({ name: `service-${i}`, enabled: true })),
    },
  };
}

it.each(['bot', 'team'])('searches a large %s catalog without losing hidden selections or counts', async mode => {
  const data = catalog();
  const container = await renderCatalog(mode, data);
  expect(container.textContent).toContain('1000 of 1000 selected');
  expect(container.textContent).toContain('200 of 200 selected');
  await search(container, 'Search skills', 'UNIQUE DEPLOYMENT');
  expect(container.querySelectorAll('fieldset[aria-label="Skills"] input[type="checkbox"]')).toHaveLength(1);
  expect(container.querySelectorAll('fieldset[aria-label="MCP servers"] input[type="checkbox"]')).toHaveLength(200);
  await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Allow skill workflow-999"]')!.click());
  expect(data.policy.skills).toHaveLength(999);
  expect(data.policy.skills).toContain('workflow-0');
  expect(data.policy.skills).not.toContain('workflow-999');
  expect(container.textContent).toContain('999 of 1000 selected');
  await search(container, 'Search MCP servers', 'service-199');
  await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Allow MCP service-199"]')!.click());
  expect(data.policy.mcpServers).toHaveLength(199);
  expect(data.policy.mcpServers).toContain('service-0');
  await search(container, 'Search skills', 'no match');
  expect(container.textContent).toContain('No skills match');
  expect(container.textContent).toContain('999 of 1000 selected');
  await search(container, 'Search skills', '');
  expect(container.querySelectorAll('fieldset[aria-label="Skills"] input[type="checkbox"]')).toHaveLength(1000);
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Allow skill workflow-999"]')!.checked).toBe(false);
});

it('summarizes large inherited limits and keeps blocked resources searchable', async () => {
  const data = catalog();
  data.inherited.skills = data.catalog.skills.slice(0, 999).map(row => row.name);
  const container = await renderCatalog('bot', data);
  const summary = container.querySelector('[aria-label="Skills team limit"]');
  expect(summary?.textContent).toBe('Team allows 999 skills.');
  expect(summary?.textContent).not.toContain('workflow');
  expect(container.textContent).toContain('999 of 1000 selected');
  await search(container, 'Search skills', 'workflow-999');
  expect(container.textContent).toContain('Not allowed by team');
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Allow skill workflow-999"]')!.disabled).toBe(true);
});
