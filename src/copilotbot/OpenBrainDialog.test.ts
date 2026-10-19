// @vitest-environment happy-dom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { it, expect, vi } from 'vitest';
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/state/store', () => ({ api }));
vi.mock('@/hooks/use-modal-dialog', () => ({ useModalDialog: vi.fn() }));
vi.mock('./OpenBrainSetup', () => ({ OpenBrainSetup: () => null }));
vi.mock('./plugins/SharedWebApp', () => ({
  SharedWebApp: ({ sessionId }: { sessionId?: string }) => createElement('div', { 'data-brain-session': sessionId ?? '' }),
}));
const { OpenBrainDialog } = await import('./OpenBrainDialog');

it('binds an already-open workspace to its new session after first-time setup and clears delivered captures', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let state: { pending: number; error?: string; link?: { id: string } } = { pending: 3, error: 'fetch failed' };
  api.mockImplementation(async (path: string) => path === '/api/plugins'
    ? { plugins: [{ manifest: { id: 'open-brain-lite', pages: [{ id: 'workspace', webApp: { module: 'embedded.js' } }] } }] }
    : state);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  try {
    await act(async () => root.render(createElement(OpenBrainDialog, { onClose: () => {}, threadId: 'thread-one' })));
    expect(document.body.textContent).toContain('3 captures pending');
    state = { pending: 0, link: { id: 'created-session' } };
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(document.querySelector('[data-brain-session]')?.getAttribute('data-brain-session')).toBe('created-session');
    expect(document.body.textContent).toContain('Shared workspace');
    expect(document.body.textContent).not.toContain('fetch failed');
    expect(api.mock.calls.filter(([path]) => path === '/api/plugins')).toHaveLength(1);
    await act(async () => root.unmount());
    mounted = false;
    const calls = api.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(api).toHaveBeenCalledTimes(calls);
  } finally {
    if (mounted) await act(async () => root.unmount());
    host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
  }
});
