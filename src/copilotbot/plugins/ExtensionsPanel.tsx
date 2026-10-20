import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Puzzle, RefreshCw, X } from 'lucide-react';
import { api } from '@/state/store';
import type { PluginListing, PluginSettings } from '../../../shared/plugins';
import { OpenBrainSetup } from '../OpenBrainSetup';
import { PluginPage } from './PluginPage';
import { glassPopupFrameStyle } from '@/lib/glass-popup';
import { useModalDialog } from '@/hooks/use-modal-dialog';

const button = 'rounded-lg border border-edge px-3 py-2 text-sm hover:bg-raised disabled:opacity-50';

function Settings({ plugin, saved }: { plugin: PluginListing; saved: () => Promise<void> }) {
  const [draft, setDraft] = useState<PluginSettings>({ ...plugin.settings });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <form className="space-y-4" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api(`/api/plugins/${plugin.manifest.id}/settings`, { method: 'PUT', body: JSON.stringify(draft) }); await saved(); }
    catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  }}>
    <p className="text-sm text-ink-secondary">Settings belong to this extension. Secrets stay on this computer and are never returned to its page.</p>
    {Object.entries(plugin.manifest.settings).map(([key, field]) => <label key={key} className="block space-y-1 text-sm">
      <span className="font-medium">{field.label}</span>
      {field.type === 'boolean' ? <input type="checkbox" className="ml-3" checked={draft[key] === true} onChange={event => setDraft({ ...draft, [key]: event.target.checked })} />
        : <input aria-label={field.label} type={field.type === 'secret' ? 'password' : field.type === 'url' ? 'url' : 'text'} autoComplete="off" required={field.required && !plugin.configuredSecrets.includes(key)} value={typeof draft[key] === 'string' ? draft[key] as string : ''} placeholder={plugin.configuredSecrets.includes(key) ? 'Saved — leave unchanged to keep' : ''} className="block w-full rounded-lg border border-edge bg-control px-3 py-2" onChange={event => setDraft({ ...draft, [key]: event.target.value })} />}
      {field.description && <span className="block text-xs text-ink-secondary">{field.description}</span>}
    </label>)}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <button className={button} disabled={busy}>Save settings</button>
  </form>;
}

export function ExtensionsPanel({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  useModalDialog(dialog, onClose);
  const [plugins, setPlugins] = useState<PluginListing[]>([]);
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState('settings');
  const [query, setQuery] = useState('');
  const [directory, setDirectory] = useState('');
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => { try { const result = await api('/api/plugins'); setPlugins(result.plugins); setError(result.error ?? ''); } catch (cause) { setError(String(cause)); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!plugins.some(plugin => plugin.status === 'starting')) return;
    const timer = setTimeout(() => { void refresh(); }, 1000);
    return () => clearTimeout(timer);
  }, [plugins, refresh]);
  const plugin = plugins.find(row => row.manifest.id === selected);
  const page = plugin?.manifest.pages.find(row => `page:${row.id}` === tab);
  return <div className="glass-popup-frame" style={glassPopupFrameStyle()} onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="App extensions" className="glass-surface glass-popup relative flex h-[85dvh] w-full max-w-[1000px] flex-col overflow-hidden rounded-3xl text-ink">
      <header className="flex items-center gap-3 border-b border-edge p-4 sm:p-6">
        {plugin ? <button className={button} aria-label="Back to extensions" onClick={() => setSelected(undefined)}><ArrowLeft size={18} /></button> : <Puzzle size={24} />}
        <div className="min-w-0 flex-1"><h2 className="truncate text-xl font-semibold">{plugin?.manifest.name ?? 'App extensions'}</h2><p className="text-xs text-ink-secondary">{plugin ? `${plugin.manifest.version} · ${plugin.status}` : `${plugins.filter(row => row.enabled).length} enabled · ${plugins.length} installed`}</p></div>
        <button className={button} aria-label="Refresh extensions" onClick={() => { void refresh(); }}><RefreshCw size={16} /></button>
        <button className={button} aria-label="Close extensions" onClick={onClose}><X size={18} /></button>
      </header>
      {error && <p role="alert" className="px-6 py-3 text-sm text-danger">{error}</p>}
      {!plugin ? <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-6">
        <p className="text-sm text-ink-secondary">Extend CopilotBot with new pages, backend commands, skills, and MCP tools. Install only plugins whose code you trust: their backends run local Node code.</p>
        <OpenBrainSetup onRuntimeChange={() => { void refresh(); }} />
        <input type="search" aria-label="Search extensions" placeholder="Search installed extensions" value={query} onChange={event => setQuery(event.target.value)} className="w-full rounded-lg border border-edge bg-control px-3 py-2" />
        <div className="space-y-3">{plugins.filter(row => `${row.manifest.name} ${row.manifest.description}`.toLowerCase().includes(query.toLowerCase())).map(row => <article key={row.manifest.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-edge p-4">
          <div className="min-w-0 flex-1"><h3 className="font-semibold">{row.manifest.name}</h3><p className="text-sm text-ink-secondary">{row.manifest.description}</p><p className="mt-1 text-xs text-ink-secondary">{row.manifest.version} · {row.status}{row.manifest.mcp.length ? ` · ${row.manifest.mcp.length} MCP` : ''}</p>{row.error && <p role="alert" className="text-sm text-danger">{row.error}</p>}</div>
          <button className={button} onClick={() => { setSelected(row.manifest.id); setTab(row.status === 'ready' && row.manifest.pages.length ? `page:${row.manifest.pages[0]!.id}` : 'settings'); }}>Open {row.manifest.name}</button>
          <button className={button} role="switch" aria-label={`Enable ${row.manifest.name}`} aria-checked={row.enabled} onClick={async () => { try { await api(`/api/plugins/${row.manifest.id}/enable`, { method: 'PUT', body: JSON.stringify({ enabled: !row.enabled }) }); await refresh(); } catch (cause) { setError(String(cause)); } }}>{row.enabled ? 'Disable' : 'Enable'}</button>
        </article>)}</div>
        {!plugins.length && <p className="text-sm text-ink-secondary">No extensions installed.</p>}
        <form className="space-y-3 rounded-xl border border-edge p-4" onSubmit={async event => {
          event.preventDefault(); setInstalling(true); setError('');
          try { await api('/api/plugins/install', { method: 'POST', body: JSON.stringify({ directory, trust: true }) }); setDirectory(''); await refresh(); } catch (cause) { setError(String(cause)); } finally { setInstalling(false); }
        }}><h3 className="font-semibold">Install from a folder</h3><p className="text-sm text-ink-secondary">Choose a plugin folder on the computer running CopilotBot. Installing copies its files; enabling runs its backend.</p><label className="block text-sm">Plugin folder<input required aria-label="Plugin folder" value={directory} onChange={event => setDirectory(event.target.value)} placeholder="/path/to/my-plugin" className="mt-1 block w-full rounded-lg border border-edge bg-control px-3 py-2" /></label><button className={button} disabled={installing}>Install trusted plugin</button></form>
      </div> : <>
        <nav aria-label="Extension pages" className="flex gap-2 overflow-x-auto border-b border-edge px-4 py-3">
          {plugin.manifest.pages.map(row => <button key={row.id} className={button} aria-pressed={tab === `page:${row.id}`} disabled={plugin.status !== 'ready'} onClick={() => setTab(`page:${row.id}`)}>{row.title}</button>)}
          <button className={button} aria-pressed={tab === 'settings'} onClick={() => setTab('settings')}>Settings</button>
        </nav>
        {page && plugin.status === 'ready' ? <PluginPage key={`${plugin.manifest.id}:${page.id}`} plugin={plugin} page={page} /> : <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">{plugin.manifest.id === 'open-brain-lite' && <OpenBrainSetup onRuntimeChange={() => { void refresh(); }} />}<Settings key={plugin.manifest.id} plugin={plugin} saved={refresh} /><p className="mt-6 text-xs text-ink-secondary">MCP tools and skills appear in bot and team access settings while this extension is enabled. Your existing limits still apply.</p></div>}
      </>}
    </section>
  </div>;
}
