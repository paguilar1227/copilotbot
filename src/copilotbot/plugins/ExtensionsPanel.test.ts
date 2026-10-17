// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { pluginManifestSchema } from '../../../shared/plugins';
import { ExtensionsPanel } from './ExtensionsPanel';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/state/store', () => ({ api: request }));
vi.mock('./PluginPage', () => ({ PluginPage: () => createElement('div', { 'data-plugin-page': true }, 'Plugin content') }));

it('keeps native settings reachable when a plugin names its page settings', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const manifest = pluginManifestSchema.parse({ format: 'copilotbot.plugin', apiVersion: 1, id: 'example', name: 'Example', version: '1.0.0', description: 'Example', pages: [{ id: 'settings', title: 'Board', entry: 'ui/index.html' }], settings: { title: { type: 'text', label: 'Board title' } } });
  request.mockResolvedValue({ plugins: [{ manifest, enabled: true, status: 'ready', settings: { title: 'My board' }, configuredSecrets: [] }] });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ExtensionsPanel, { onClose() {} })));
    const button = (name: string) => [...container.querySelectorAll('button')].find(element => element.textContent === name)!;
    await act(async () => button('Open Example').click());
    expect(container.querySelector('[data-plugin-page]')).not.toBeNull();
    await act(async () => button('Settings').click());
    expect(container.querySelector('[data-plugin-page]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Board title"]')?.value).toBe('My board');
    await act(async () => button('Board').click());
    expect(container.querySelector('[data-plugin-page]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});
