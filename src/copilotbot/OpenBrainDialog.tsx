import { OpenBrainSetup } from './OpenBrainSetup';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useModalDialog } from '@/hooks/use-modal-dialog';
import { api } from '@/state/store';
import { SharedWebApp } from './plugins/SharedWebApp';
import type { PluginListing } from '../../shared/plugins';
export function OpenBrainDialog({ onClose, threadId }: { onClose(): void; threadId?: string }) {
  const dialog = useRef<HTMLDivElement>(null);
  useModalDialog(dialog, onClose);
  const [runtimeReload, setRuntimeReload] = useState(0);
  const [plugin, setPlugin] = useState<PluginListing>();
  const [link, setLink] = useState<string>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(0);
  useEffect(() => {
    let active = true;
    let request = 0;
    void api('/api/plugins').then(plugins => {
      if (active) setPlugin(plugins.plugins.find((p: PluginListing) => p.manifest.id === 'open-brain-lite'));
    }).catch(cause => { if (active) setError(String(cause)); });
    const refresh = () => {
      const current = ++request;
      return api(`/api/copilotbot/open-brain?threadId=${encodeURIComponent(threadId ?? '')}`).then(state => {
        if (!active || current !== request) return;
        setLink(state.link?.id); setPending(state.pending ?? 0); setError(state.error ?? '');
      }).catch(cause => { if (active && current === request) setError(String(cause)); });
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2000);
    return () => { active = false; window.clearInterval(interval); };
  }, [threadId, runtimeReload]);
  const page = plugin?.manifest.pages.find(page => page.webApp);
  return createPortal(<div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Open Brain" className="fixed inset-0 z-50 flex flex-col bg-app text-ink">
    <header className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-3"><strong>Open Brain</strong><span className="text-[12px] text-ink-secondary">{pending ? `${pending} captures pending` : 'Shared workspace'}</span><button type="button" aria-label="Close Open Brain" onClick={onClose} className="ml-auto rounded-md p-2 hover:bg-raised"><X size={18} /></button></header>
    <OpenBrainSetup compact onRuntimeChange={() => setRuntimeReload(value => value + 1)} />
    {error && <p role="alert" className="px-4 py-2 text-[13px] text-danger">{error}<button className="ml-3 underline" onClick={() => void api('/api/copilotbot/open-brain/retry', { method: 'POST' }).then(state => { setPending(state.pending ?? 0); setError(state.error ?? ''); })}>Retry pending captures</button></p>}
    {plugin?.enabled && page ? <SharedWebApp key={runtimeReload} plugin={plugin} page={page} sessionId={link} /> : <p className="p-6">Install or enable the Open Brain Lite extension to open its workspace.</p>}
  </div>, document.body);
}
