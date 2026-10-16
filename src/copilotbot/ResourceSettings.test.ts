// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Bot } from '@/state/store';
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
  expect(container.querySelector('fieldset')?.disabled).toBe(true);
  fixture.bots = [{ ...fixture.bots[0]!, busy: false }];
  await act(async () => root!.render(render()));
  expect(container.querySelector('fieldset')?.disabled).toBe(false);
});
