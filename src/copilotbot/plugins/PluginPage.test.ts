// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginPage } from './PluginPage';
import { pluginManifestSchema } from '../../../shared/plugins';

const request = vi.hoisted(() => vi.fn(async () => ({ result: 'saved' })));
vi.mock('@/state/store', () => ({ api: request }));
afterEach(() => vi.restoreAllMocks());

it('allows JavaScript form events and bridges only the mounted page and declared commands', async () => {
  const createNativeElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((name: string, options?: ElementCreationOptions) => {
    const element = createNativeElement(name, options);
    if (name === 'iframe') element.setAttribute('srcdoc', '<!doctype html><html><body></body></html>');
    return element;
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const manifest = pluginManifestSchema.parse({ format: 'copilotbot.plugin', apiVersion: 1, id: 'example', name: 'Example', version: '1.0.0', description: 'Example', backend: 'main.mjs', commands: [{ id: 'save', title: 'Save' }], pages: [{ id: 'page', title: 'Page', entry: 'ui/index.html' }] });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(PluginPage, { plugin: { manifest, enabled: true, status: 'ready', settings: {}, configuredSecrets: [] }, page: manifest.pages[0]! })));
  const frame = container.querySelector('iframe')!;
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
  expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  const channel = new URL(frame.src).hash.slice('#channel='.length);
  const message = { type: 'copilotbot:command', channel, id: '1', command: 'save', input: { title: 'Saved from form' } };
  await act(async () => window.dispatchEvent(new MessageEvent('message', { data: message, source: window })));
  expect(request).not.toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new MessageEvent('message', { data: { ...message, channel: 'wrong' }, source: frame.contentWindow })));
  expect(request).not.toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new MessageEvent('message', { data: message, source: frame.contentWindow })));
  expect(request).toHaveBeenCalledWith('/api/plugins/example/commands/save', expect.objectContaining({ method: 'POST', body: '{"title":"Saved from form"}' }));
  request.mockClear();
  await act(async () => window.dispatchEvent(new MessageEvent('message', { data: { ...message, command: 'arbitrary-host-route' }, source: frame.contentWindow })));
  expect(request).not.toHaveBeenCalled();
  await act(async () => root.unmount()); container.remove();
});
