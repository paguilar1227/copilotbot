// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ state: { config: { azure: { configured: true }, decider: { model: '', configured: false } } }, api: vi.fn(), dispatch: vi.fn() }));
vi.mock('@/state/store', () => ({ useStore: () => fixture, api: fixture.api }));
const { AzureDecisionSettings } = await import('./AzureDecisionSettings');
it('keeps the test result visible when saving the deployment refreshes configuration', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  fixture.api.mockImplementation(async (path: string, init: RequestInit) => {
    if (path === '/api/config') {
      fixture.state.config.decider = { model: JSON.parse(String(init.body)).decider.azureDeployment, configured: true };
      return fixture.state.config;
    }
    return { ok: true, latencyMs: 145 };
  });
  fixture.dispatch.mockImplementation(() => root.render(createElement(AzureDecisionSettings)));
  try {
    await act(async () => root.render(createElement(AzureDecisionSettings)));
    const input = host.querySelector<HTMLInputElement>('input')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'my-fast-deployment'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Test Azure decision model')!.click());
    expect(host.textContent).toContain('Azure answered in 145 ms');
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual(['/api/config', '/api/decider/test']);
    expect(host.querySelector('input')!.value).toBe('my-fast-deployment');
    expect(host.querySelector('input[type=password]')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
