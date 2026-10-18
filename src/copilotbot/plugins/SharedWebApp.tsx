import { useEffect, useRef, useState } from 'react';
import type { PluginListing } from '../../../shared/plugins';

type MountedApp = { unmount(): void };
export function SharedWebApp({ plugin, page, sessionId }: { plugin: PluginListing; page: PluginListing['manifest']['pages'][number]; sessionId?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false, mounted: MountedApp | undefined;
    const root = host.current;
    if (!root || !page.webApp) return;
    const base = `/api/plugins/${plugin.manifest.id}/web/${page.id}`;
    const start = async () => {
      try {
        const module = await import(/* @vite-ignore */ `${base}/${page.webApp!.module}?load=${Date.now()}`);
        if (disposed) return;
        mounted = await module.mount(root, { apiBase: `${base}/api/v1`, assetBase: base, ...(sessionId ? { initialRoute: { route: 'session', session: sessionId } } : {}) });
        if (disposed) mounted?.unmount();
      } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); }
    };
    setError(''); void start();
    return () => { disposed = true; mounted?.unmount(); };
  }, [plugin.manifest.id, page.id, page.webApp?.module, retry, sessionId]);
  return <div className="relative flex min-h-0 flex-1 flex-col">
    {error && <div role="alert" className="m-6 rounded-xl border border-hairline p-5 text-[14px] text-ink"><p>Open Brain could not open. Check its connection in App extensions, then retry.</p><p className="my-2 text-ink-secondary">{error}</p><button className="rounded-lg bg-control px-3 py-2" onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
    <div ref={host} className="min-h-0 flex-1" aria-label="Open Brain workspace" />
  </div>;
}
