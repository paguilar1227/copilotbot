// @vitest-environment happy-dom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ state: { config: { azure: { auth: 'api-key', endpoint: 'https://fixture.openai.azure.com' } } }, api: vi.fn(), dispatch: vi.fn(), refreshInstances: vi.fn(async () => {}), refreshModels: vi.fn(async () => {}) }));
vi.mock('@/state/store', () => ({
  api: fixture.api,
  useStore: () => ({ ...fixture }),
}));
vi.mock('@/components/DeviceSignIn', () => ({ DeviceSignIn: () => null }));
const { AzureSettings } = await import('./AzureSettings');

it('allows typing multiple deployment names before saving', async () => {
  fixture.api.mockResolvedValue({ azure: { auth: 'api-key', endpoint: 'https://fixture.openai.azure.com', configured: true } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(AzureSettings)));
    const input = host.querySelector<HTMLInputElement>('[aria-label="Azure chat deployments"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    for (const value of ['first-model', 'first-model,', 'first-model, second-model']) {
      await act(async () => { set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
      expect(input.value).toBe(value);
    }
    const save = [...host.querySelectorAll('button')].find(button => button.textContent === 'Save Azure settings')!;
    await act(async () => save.click());
    expect(JSON.parse(fixture.api.mock.calls[0]![1].body).azure.models).toEqual(['first-model', 'second-model']);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
