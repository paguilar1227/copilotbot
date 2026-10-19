// @vitest-environment happy-dom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { it, expect, vi } from 'vitest';
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/state/store', () => ({ api }));
const { OpenBrainSetup } = await import('./OpenBrainSetup');
it('shows a recoverable first install and sends only the selected setup action', async () => {
  api.mockResolvedValue({ phase: 'docker-missing', managed: true, windows: true, busy: false, message: 'Install Docker Desktop' });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(OpenBrainSetup)));
    expect(host.textContent).toContain('Enable or update WSL');
    const install = [...host.querySelectorAll('button')].find(button => button.textContent === 'Install Docker Desktop')!;
    await act(async () => install.click());
    expect(api).toHaveBeenCalledWith('/api/copilotbot/open-brain/setup/docker', { method: 'POST' });
  } finally { await act(async () => root.unmount()); host.remove(); }
});
it('hides the compact setup panel when the service is ready', async () => {
  api.mockResolvedValue({ phase: 'ready', managed: true, windows: true, busy: false, message: 'Ready' });
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(OpenBrainSetup, { compact: true })));
    expect(host.textContent).toBe('');
  } finally { await act(async () => root.unmount()); }
});
