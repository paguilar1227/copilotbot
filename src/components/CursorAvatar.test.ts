// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CursorAvatar } from './CursorAvatar';

it('paints the selected facial expression even when animation is paused', async () => {
  vi.useFakeTimers();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const host = document.createElement('div');
  const root = createRoot(host);
  const face = () => [...host.querySelectorAll('path[fill="#ffffff"], path[stroke="#ffffff"]')].map(path => path.getAttribute('d'));
  const paint = () => { for (const callback of frames.splice(0)) callback(performance.now()); };
  try {
    await act(async () => root.render(createElement(CursorAvatar, { state: 'happy', paused: true })));
    paint();
    const happy = face();
    expect(happy).toHaveLength(3);
    expect(happy.slice(0, 2).every(Boolean)).toBe(true);
    await act(async () => root.render(createElement(CursorAvatar, { state: 'suspicious', paused: true })));
    await act(async () => vi.advanceTimersToNextTimer());
    paint();
    expect(face()).not.toEqual(happy);
    await act(async () => root.render(createElement(CursorAvatar, { state: 'happy', paused: true })));
    await act(async () => vi.advanceTimersToNextTimer());
    paint();
    expect(face()).toEqual(happy);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
