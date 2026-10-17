import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, ChevronLeft, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { api, useStore } from '@/state/store';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Select } from '@/components/Select';
import { BotAvatar } from '@/components/Avatar';
import { stateForBot } from '@/lib/mascot';
import type { RosterDetail, RosterListing, RosterSummary, RosterDeployment, TeamTemplateDefinition } from '../../shared/roster';

const field = 'w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink';
const button = 'rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised disabled:opacity-40';
const pathFor = (entry: Pick<RosterSummary, 'id' | 'kind'>) => `/api/copilotbot/roster/${entry.kind}s${entry.id ? `/${entry.id}` : ''}`;
const blankTeam = (): TeamTemplateDefinition => ({ name: '', description: '', members: [], instructions: '', resources: { skills: null, mcpServers: null }, peers: {}, rooms: [] });

function TeamEditor({ initial, bots, onSave, pending }: { initial: TeamTemplateDefinition; bots: RosterSummary[]; onSave: (definition: TeamTemplateDefinition) => Promise<void>; pending: boolean }) {
  const [value, setValue] = useState(initial);
  const [query, setQuery] = useState('');
  const [advanced, setAdvanced] = useState(JSON.stringify({ resources: initial.resources, peers: initial.peers, rooms: initial.rooms }, null, 2));
  const [error, setError] = useState('');
  const save = async () => {
    setError('');
    try {
      const setup = JSON.parse(advanced);
      const members = new Set(value.members);
      const peers = Object.fromEntries(Object.entries(setup.peers ?? {}).filter(([id]) => members.has(id)).map(([id, peers]) => [id, peers === null ? null : (peers as string[]).filter(id => members.has(id))]));
      const rooms = (setup.rooms ?? []).map((room: TeamTemplateDefinition['rooms'][number]) => {
        const ids = room.members.filter(id => members.has(id));
        const selected = room.responder.kind === 'member' ? room.responder.botId : room.responder.kind === 'auto' ? room.responder.fallbackBotId : undefined;
        return { ...room, members: ids, responder: selected && !ids.includes(selected) ? { kind: 'mentions' as const } : room.responder };
      }).filter((room: TeamTemplateDefinition['rooms'][number]) => room.members.length);
      await onSave({ ...value, resources: setup.resources, peers, rooms });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="space-y-4">
    <label className="block text-[13px] text-ink-secondary">Team name<input className={`${field} mt-1`} value={value.name} onChange={event => setValue({ ...value, name: event.target.value })} /></label>
    <label className="block text-[13px] text-ink-secondary">Description<input className={`${field} mt-1`} value={value.description} onChange={event => setValue({ ...value, description: event.target.value })} /></label>
    <fieldset className="rounded-xl bg-card p-4">
      <legend className="px-1 text-[14px] font-medium text-ink">Bot templates · {value.members.length} selected</legend>
      <input className={field} type="search" aria-label="Search saved bot templates" placeholder="Search saved bots" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="mt-2 max-h-64 overflow-auto" role="region" aria-label="Team template members" tabIndex={0}>
        {bots.filter(bot => `${bot.name} ${bot.description}`.toLowerCase().includes(query.toLowerCase())).map(bot => <label key={bot.id} className="flex items-start gap-3 border-b border-hairline/40 py-3 text-[13px] text-ink">
          <input type="checkbox" className="mt-1" checked={value.members.includes(bot.id)} onChange={event => setValue({ ...value, members: event.target.checked ? [...value.members, bot.id] : value.members.filter(id => id !== bot.id) })} />
          <span className="min-w-0 break-words"><span className="font-medium">{bot.name}</span><span className="block text-ink-secondary">{bot.description}</span></span>
        </label>)}
        {!bots.length && <p className="py-3 text-[13px] text-ink-secondary">Save a bot template first, then add it to this team.</p>}
      </div>
      <p className="mt-2 text-[12px] text-ink-secondary">Removing a member also removes it from this template’s chats and peer lists. Deployed teams are unchanged.</p>
    </fieldset>
    <label className="block text-[13px] text-ink-secondary">Shared team instructions<textarea className={`${field} mt-1 min-h-28`} value={value.instructions} onChange={event => setValue({ ...value, instructions: event.target.value })} /></label>
    <details className="rounded-xl border border-hairline p-3">
      <summary className="cursor-pointer text-[13px] text-ink">Edit access limits and chat definitions</summary>
      <p className="my-2 text-[12px] text-ink-secondary">Resource selections and chat members use saved template IDs. Invalid or missing references are rejected when you save.</p>
      <textarea aria-label="Team access and chat definitions JSON" className={`${field} min-h-64 font-mono text-[12px]`} value={advanced} onChange={event => setAdvanced(event.target.value)} spellCheck={false} />
    </details>
    {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    <button type="button" className={button} disabled={pending || !value.name.trim() || !value.members.length} onClick={() => void save()}>Save team template</button>
  </div>;
}

function BotEditor({ yaml, pending, onSave }: { yaml: string; pending: boolean; onSave: (yaml: string) => Promise<void> }) {
  const [value, setValue] = useState(yaml);
  return <div className="space-y-3">
    <p className="text-[13px] text-ink-secondary">Edit the reusable bot definition. Saving does not change any deployed bot.</p>
    <textarea aria-label="Bot template YAML" className={`${field} min-h-[50vh] font-mono text-[12px]`} value={value} onChange={event => setValue(event.target.value)} spellCheck={false} />
    <button type="button" className={button} disabled={pending || !value.trim()} onClick={() => void onSave(value)}>Save bot template</button>
  </div>;
}

export function RosterDialog({ onClose, initialSource = '' }: { onClose: () => void; initialSource?: string }) {
  const { state } = useStore();
  const [entries, setEntries] = useState<RosterSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<'all' | 'bot' | 'team'>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(new Set<string>());
  const [source, setSource] = useState(initialSource);
  const [editing, setEditing] = useState<RosterDetail | null>(null);
  const [deleting, setDeleting] = useState<RosterSummary | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const retryDeploy = useRef<{ key: string; requestId: string } | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    const data = await api<RosterListing>('/api/copilotbot/roster'); setEntries(data.entries); setLoaded(true);
    setSelected(current => new Set([...current].filter(id => data.entries.some(entry => entry.id === id))));
  }, []);
  useEffect(() => { void load().catch(cause => setError(String(cause))); }, [load]);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true; setPending(true); setError(''); setNotice('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { running.current = false; setPending(false); }
  };
  const saveSource = () => run(async () => {
    const kind = source.startsWith('bot:') ? 'bot' : 'team', id = source.slice(source.indexOf(':') + 1);
    const result = await api<{ warnings?: string[] }>(`/api/copilotbot/roster/${kind}s`, { method: 'POST', body: JSON.stringify(kind === 'bot' ? { botId: id } : { section: id }) });
    setSource(''); setNotice(['Saved to the roster. The deployed copy is unchanged.', ...(result.warnings ?? [])].join(' ')); await load();
  });
  const saveEdit = (body: { yaml: string } | { definition: TeamTemplateDefinition }) => run(async () => {
    if (!editing) return;
    await api(pathFor(editing), { method: editing.id ? 'PUT' : 'POST', body: JSON.stringify({ ...body, ...(editing.id ? { revision: editing.revision } : {}) }) });
    await load(); setEditing(null); setNotice('Template saved. Deployed copies are unchanged.');
  });
  const deploy = () => run(async () => {
    const selections = entries.filter(entry => selected.has(entry.id)).map(({ id, kind }) => ({ id, kind }));
    const key = JSON.stringify(selections);
    if (retryDeploy.current?.key !== key) retryDeploy.current = { key, requestId: crypto.randomUUID() };
    const result = await api<{ deployments: RosterDeployment[]; warnings?: string[] }>('/api/copilotbot/roster/deploy', { method: 'POST', body: JSON.stringify({ selections, requestId: retryDeploy.current.requestId }) });
    retryDeploy.current = null; setSelected(new Set()); await load();
    setNotice([`Deployed ${result.deployments.length} ${result.deployments.length === 1 ? 'template' : 'templates'}. The new bots and teams are in the sidebar.`, ...(result.warnings ?? [])].join(' '));
  });
  const visible = entries.filter(entry => (filter === 'all' || filter === entry.kind) && `${entry.name} ${entry.description}`.toLowerCase().includes(query.toLowerCase()));
  const teams = [...new Set(state.bots.filter(bot => !bot.hidden).map(bot => bot.section ?? ''))];
  const close = () => { if (!running.current) onClose(); };
  return createPortal(<div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-3 sm:p-5">
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="Saved roster" tabIndex={-1} className="flex h-[min(850px,94dvh)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-hairline bg-panel shadow-2xl outline-none" onKeyDown={event => {
      if (deleting) return;
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
      if (event.key !== 'Tab') return;
      const nodes = [...event.currentTarget.querySelectorAll<HTMLElement>('button:enabled, input:enabled, textarea:enabled, select:enabled, [tabindex="0"]')].filter(node => node.getClientRects().length);
      if (event.shiftKey && (document.activeElement === nodes[0] || document.activeElement === dialog.current)) { event.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
    }}>
      <header className="flex shrink-0 items-center justify-between border-b border-hairline px-5 py-4">
        <div className="flex items-center gap-3"><BookOpen className="text-accent" size={20} /><h2 className="text-[18px] font-semibold text-ink">Saved roster</h2></div>
        <button type="button" onClick={close} disabled={pending} aria-label="Close saved roster" className={button}><X size={18} /></button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {editing ? <>
          <button type="button" className={`${button} mb-4 flex items-center gap-1`} disabled={pending} onClick={() => { setEditing(null); setError(''); }}><ChevronLeft size={15} />Back to roster</button>
          <h3 className="mb-4 text-[16px] font-medium text-ink">{editing.id ? `Edit ${editing.name}` : `New ${editing.kind} template`}</h3>
          {editing.kind === 'bot' ? <BotEditor key={editing.id} yaml={editing.yaml} pending={pending} onSave={yaml => saveEdit({ yaml })} /> : <TeamEditor key={editing.id} initial={editing.definition} bots={entries.filter(entry => entry.kind === 'bot')} pending={pending} onSave={definition => saveEdit({ definition })} />}
        </> : <>
          <p className="mb-4 text-[13px] leading-relaxed text-ink-secondary">Keep specialist bots and teams here until you need them. Deploy fresh copies; archive working bots when you want to clear the sidebar. Templates contain settings, not chat history or learned memory.</p>
          <div className="mb-4 flex flex-wrap gap-2">
            <button type="button" className={button} disabled={pending} onClick={() => setEditing({ id: '', kind: 'bot', name: '', description: '', revision: 0, memberCount: 1, usedBy: [], activeCopies: 0, yaml: 'format: copilotbot/bot\nversion: 1\nprofile:\n  name: New specialist\n  description: Describe this bot’s job\n' })}><Plus size={13} className="mr-1 inline" />New bot template</button>
            <button type="button" className={button} disabled={pending} onClick={() => setEditing({ id: '', kind: 'team', name: '', description: '', revision: 0, memberCount: 0, usedBy: [], activeCopies: 0, definition: blankTeam() })}><Plus size={13} className="mr-1 inline" />New team template</button>
          </div>
          <div className="mb-5 flex flex-wrap gap-2 rounded-xl bg-card p-3">
            <Select aria-label="Deployed bot or team to save" value={source} disabled={pending} className="min-w-0 flex-1" onChange={event => setSource(event.target.value)}>
              <option value="">Save a deployed bot or team…</option>
              <optgroup label="Bots">{state.bots.filter(bot => !bot.hidden).map(bot => <option key={bot.id} value={`bot:${bot.id}`}>{bot.name}</option>)}</optgroup>
              <optgroup label="Teams">{teams.map(team => <option key={team} value={`team:${team}`}>{team || 'General'}</option>)}</optgroup>
            </Select>
            <button type="button" className={button} disabled={pending || !source} onClick={() => void saveSource()}>Save to roster</button>
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {(['all', 'bot', 'team'] as const).map(kind => <button type="button" key={kind} aria-pressed={kind === filter} className={`${button} ${kind === filter ? 'ring-1 ring-accent' : ''}`} onClick={() => setFilter(kind)}>{kind === 'all' ? 'All templates' : kind === 'bot' ? 'Bots' : 'Teams'}</button>)}
            <span className="text-[12px] text-ink-secondary">{selected.size} selected · {entries.length} saved</span>
          </div>
          <div className="relative mb-3"><Search size={15} className="pointer-events-none absolute left-3 top-3 text-ink-secondary" /><input type="search" aria-label="Search roster" className={`${field} pl-9`} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search bots and teams" /></div>
          {!loaded && !error && <p role="status" className="text-[13px] text-ink-secondary">Loading roster…</p>}
          {loaded && !visible.length && <p className="rounded-xl border border-dashed border-hairline p-8 text-center text-[14px] text-ink-secondary">{entries.length ? 'No templates match your search.' : 'Your roster is empty. Save a deployed bot or team, or create a template.'}</p>}
          <div role="region" aria-label="Saved templates" tabIndex={0} className="max-h-[50vh] overflow-y-auto rounded-xl border border-hairline">
            {visible.map(entry => <div key={entry.id} className="flex items-start gap-3 border-b border-hairline/40 p-3 sm:p-4">
              <input type="checkbox" aria-label={`Deploy ${entry.name}`} checked={selected.has(entry.id)} disabled={pending} className="mt-2" onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(entry.id); else next.delete(entry.id); return next; })} />
              <div className={`flex shrink-0 items-center ${entry.kind === 'team' ? '-space-x-3' : ''}`} aria-label={`${entry.name} appearance`}>
                {(entry.avatars?.length ? entry.avatars : [{ name: entry.name, color: 'green' as const }]).slice(0, entry.kind === 'team' ? 2 : 1).map((avatar, index) => <div key={`${entry.id}-${index}`} className="rounded-full bg-card ring-2 ring-card">
                  <BotAvatar bot={avatar} state={stateForBot(avatar)} size={40} animated={false} trackPointer={false} lazy />
                </div>)}
                {entry.kind === 'team' && entry.memberCount > 2 && <span className="z-10 flex size-7 items-center justify-center rounded-full bg-control text-[10px] text-ink ring-2 ring-card">+{entry.memberCount - 2}</span>}
              </div>
              <div className="min-w-0 flex-1 break-words"><h3 className="text-[14px] font-medium text-ink">{entry.name}</h3><p className="line-clamp-2 text-[12px] text-ink-secondary">{entry.description}</p>
                <p className="mt-1 text-[12px] text-ink-secondary">{entry.kind === 'team' ? `${entry.memberCount} bots · ` : ''}{entry.activeCopies ? `${entry.activeCopies} deployed ${entry.activeCopies === 1 ? 'copy' : 'copies'}` : 'Not deployed'}</p>
                {!!entry.usedBy.length && <p className="mt-1 text-[12px] text-ink-secondary">Used by {entry.usedBy.map(team => team.name).join(', ')}</p>}
              </div>
              <div className="flex shrink-0 gap-1">
                <button type="button" aria-label={`Edit ${entry.name}`} title="Edit template" className={button} disabled={pending} onClick={() => void run(async () => setEditing(await api<RosterDetail>(pathFor(entry))))}><Pencil size={15} /></button>
                <button type="button" aria-label={`Delete ${entry.name}`} title="Delete template" className={button} disabled={pending} onClick={() => {
                  if (entry.usedBy.length) { setError(`Used by team templates: ${entry.usedBy.map(team => team.name).join(', ')}. Edit those teams before deleting this bot template.`); return; }
                  setDeleting(entry);
                }}><Trash2 size={15} /></button>
              </div>
            </div>)}
          </div>
        </>}
        {error && <div role="alert" className="mt-4 text-[13px] text-danger">{error}<button type="button" className="ml-2 underline" disabled={pending} onClick={() => void run(load)}>Refresh roster</button></div>}
        {notice && <p role="status" className="mt-4 text-[13px] text-success">{notice}</p>}
      </main>
      {!editing && <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-hairline px-5 py-4">
        <p className="max-w-md text-[12px] text-ink-secondary">Fresh copies start with Ask permissions and paused routines. Existing bots and teams are unchanged.</p>
        <button type="button" disabled={pending || !selected.size} onClick={() => void deploy()} className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40">{pending ? 'Working…' : `Deploy selected (${selected.size})`}</button>
      </footer>}
    </div>
    <ConfirmDialog zIndex={90} open={!!deleting} title={`Delete ${deleting?.name ?? ''}?`} body="This removes the saved template. Deployed copies and their chats are kept." confirmLabel="Delete template" pending={pending} onCancel={() => { if (!pending) setDeleting(null); }} onConfirm={() => void run(async () => {
      if (!deleting) return;
      try { await api(pathFor(deleting), { method: 'DELETE', body: JSON.stringify({ revision: deleting.revision }) }); }
      finally { setDeleting(null); }
      await load(); setNotice('Template deleted.');
    })} />
  </div>, document.body);
}
