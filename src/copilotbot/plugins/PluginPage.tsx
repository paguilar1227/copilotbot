import { useCallback, useEffect, useRef, useState } from 'react';
import { SharedWebApp } from './SharedWebApp';
import { api } from '@/state/store';
import type { PluginListing, PluginPageRequest } from '../../../shared/plugins';

export function PluginPage({ plugin, page }: { plugin: PluginListing; page: PluginListing['manifest']['pages'][number] }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [channel] = useState(() => crypto.randomUUID());
  const sendTheme = useCallback(() => frame.current?.contentWindow?.postMessage({ type: 'copilotbot:theme', channel, scheme: getComputedStyle(document.documentElement).getPropertyValue('--code-color-scheme').trim() === 'dark' ? 'dark' : 'light' }, '*'), [channel]);
  useEffect(() => {
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement, { attributes: true });
    observer.observe(document.body, { attributes: true });
    return () => observer.disconnect();
  }, [sendTheme]);
  useEffect(() => {
    const abort = new AbortController();
    const listener = async (event: MessageEvent<PluginPageRequest>) => {
      const source = frame.current?.contentWindow;
      if (!source || event.source !== source || event.data?.type !== 'copilotbot:command' || event.data.channel !== channel || typeof event.data.id !== 'string') return;
      const message = event.data;
      let result: unknown, error: string | undefined;
      try {
        if (!plugin.manifest.commands.some(command => command.id === message.command)) throw new Error('Unknown plugin command');
        result = (await api(`/api/plugins/${plugin.manifest.id}/commands/${message.command}`, { method: 'POST', body: JSON.stringify(message.input ?? null), signal: abort.signal })).result;
      } catch (cause) { error = cause instanceof Error ? cause.message : 'Command failed'; }
      if (!abort.signal.aborted) frame.current?.contentWindow?.postMessage({ type: 'copilotbot:result', channel, id: message.id, result, error }, '*');
    };
    window.addEventListener('message', listener);
    return () => { abort.abort(); window.removeEventListener('message', listener); };
  }, [channel, plugin.manifest]);
  if (page.webApp) return <SharedWebApp key={plugin.manifest.version} plugin={plugin} page={page} />;
  return <iframe ref={frame} title={page.title} onLoad={sendTheme} sandbox="allow-scripts allow-forms" className="min-h-[380px] w-full flex-1 border-0 bg-app" src={`/api/plugins/${plugin.manifest.id}/assets/${page.entry}#channel=${channel}`} />;
}
