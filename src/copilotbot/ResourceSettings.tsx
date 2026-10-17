import { useEffect, useState } from 'react';
import { useBotEditor } from '@/components/bot-settings/BotEditorContext';
import { api, useStore, type Bot } from '@/state/store';
import { Select } from '@/components/Select';
import type { ResourceAccess, ResourceState, ResourceRow } from '../../shared/bot-resources';


function ResourceList({ kind, known, selected, inherited, disabled, onChange }: {
  kind: keyof ResourceAccess;
  known: ResourceRow[];
  selected: string[] | null;
  inherited: string[] | null;
  disabled: boolean;
  onChange: (names: string[] | null) => void;
}) {
  const [query, setQuery] = useState('');
  const label = kind === 'skills' ? 'Skills' : 'MCP servers';
  const mode = selected === null ? 'all' : selected.length === 0 ? 'none' : 'selected';
  const knownNames = new Set(known.map(row => row.name));
  const selectedNames = selected === null ? null : new Set(selected);
  const inheritedNames = inherited === null ? null : new Set(inherited);
  const rows: ResourceRow[] = [...known, ...(selected ?? []).filter(name => !knownNames.has(name)).map(name => ({ name, enabled: false }))];
  const teamAllows = (name: string) => inheritedNames === null || inheritedNames.has(name);
  const isSelected = (row: ResourceRow) => teamAllows(row.name) && (selectedNames === null ? row.enabled : selectedNames.has(row.name));
  const search = query.trim().toLowerCase();
  const visible = rows.filter(row => `${row.displayName ?? row.name} ${row.description ?? ''} ${row.source ?? ''}`.toLowerCase().includes(search));
  const selectedCount = rows.filter(isSelected).length;
  return <fieldset aria-label={label} className="min-w-0 rounded-xl bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-[15px] font-medium text-ink">{label}</span>
      <Select aria-label={`${label} access`} value={mode} disabled={disabled} onChange={event => {
        const value = event.target.value;
        onChange(value === 'all' ? null : value === 'none' ? [] : known.filter(row => row.enabled && teamAllows(row.name)).map(row => row.name));
      }}>
        <option value="all">All available</option><option value="selected">Selected only</option><option value="none">None</option>
      </Select>
    </div>
    <p aria-live="polite" aria-atomic="true" className="mt-2 text-[12px] text-ink-secondary">{selectedCount} of {rows.length} selected</p>
    {inheritedNames !== null && <p aria-label={`${label} team limit`} className="mt-1 text-[12px] text-ink-secondary">Team allows {inheritedNames.size} {kind === 'skills' ? 'skills' : 'MCP servers'}.</p>}
    <input type="search" aria-label={`Search ${kind === 'skills' ? 'skills' : 'MCP servers'}`} placeholder={`Search ${kind === 'skills' ? 'skills' : 'MCP servers'}`} value={query}
      onChange={event => setQuery(event.target.value)} className="mt-3 w-full min-w-0 rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent" />
    <div role="region" aria-label={`${label} list`} tabIndex={0} className="mt-2 max-h-[min(40vh,22rem)] overflow-y-auto overscroll-contain rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent">
      {!rows.length ? <p className="py-2 text-[13px] text-ink-secondary">No {label.toLowerCase()} configured yet.</p>
        : !visible.length ? <p role="status" className="py-2 text-[13px] text-ink-secondary">No {label.toLowerCase()} match “{query.trim()}”.</p>
        : <div className="divide-y divide-hairline/40">{visible.map(row => <label key={row.name} className="flex items-start gap-3 py-2 text-[13px] text-ink">
          <input type="checkbox" aria-label={`Allow ${kind === 'skills' ? 'skill' : 'MCP'} ${row.displayName ?? row.name}${row.source ? ` (${row.source})` : ""}`} className="mt-1 shrink-0" checked={isSelected(row)}
            disabled={disabled || !teamAllows(row.name) || (!row.enabled && !selectedNames?.has(row.name))} onChange={event => {
              const current = selected ?? known.filter(item => item.enabled).map(item => item.name);
              onChange(event.target.checked ? [...new Set([...current, row.name])] : current.filter(name => name !== row.name));
            }} />
          <span className="min-w-0 break-words"><span className="font-medium">{row.displayName ?? row.name}</span>
            {row.source && <span className="block text-[12px] text-ink-secondary">{row.source}</span>}
            {row.description && <span className="line-clamp-2 text-[12px] text-ink-secondary">{row.description}</span>}
            {!teamAllows(row.name) ? <span className="block text-[12px] text-ink-secondary">Not allowed by team</span> : !row.enabled ? <span className="block text-[12px] text-ink-secondary">Missing or disabled — install and review before use</span> : null}
          </span>
        </label>)}</div>}
    </div>
  </fieldset>;
}

export function ResourceSettings({ bot, team }: { bot?: Bot; team?: string }) {
  const editor = useBotEditor();
  const { state } = useStore();
  const request = bot ? editor.request : api;
  const path = bot ? `/api/copilotbot/bots/${bot.id}/resources` : `/api/copilotbot/resources?section=${encodeURIComponent(team ?? '')}`;
  const [data, setData] = useState<ResourceState | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setData(null); setError('');
    void request<ResourceState>(path).then(result => { if (!cancelled) setData(result); })
      .catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [path, request, revision, bot?.section]);
  const save = async (policy: ResourceAccess) => {
    setSaving(true); setError('');
    try {
      const result = await request<ResourceState>(path, { method: 'PUT', body: JSON.stringify(policy) });
      setData(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  const busy = bot ? !!bot.busy : state.bots.some(member => (member.section ?? '') === (team ?? '') && member.busy);
  const disabled = saving || busy;
  return <section className="space-y-4" aria-label="Resource access">
    <div className="flex items-center justify-between gap-3"><span className="text-[13px] font-medium text-ink">Available resources</span><button type="button" disabled={saving} className="text-[13px] text-accent disabled:opacity-40" onClick={() => setRevision(value => value + 1)}>Refresh resources</button></div>
    <p className="text-[13px] text-ink-secondary">{bot
      ? 'Choose the skills and MCP servers this bot can use, including inherited Copilot resources. Team limits also apply. Skills must be installed and enabled.'
      : 'Team limits apply to every member, including bots added later. Each bot can select a smaller set. Skills must also be assigned and enabled for that bot.'}</p>
    {data?.warnings?.map(message => <p key={message} role="status" className="text-[12px] text-warning">{message}</p>)}
    {data && (['skills', 'mcpServers'] as const).map(kind => <ResourceList key={`${path}:${kind}`} kind={kind} known={data.catalog[kind]} selected={data.policy[kind]} inherited={data.inherited[kind]} disabled={disabled}
      onChange={names => { void save({ ...data.policy, [kind]: names }); }} />)}
    {!data && !error && <p role="status" className="text-[13px] text-ink-secondary">Loading resources…</p>}
    {disabled && <p role="status" className="text-[12px] text-ink-secondary">{saving ? 'Saving…' : 'Stop the affected bots to change resource access.'}</p>}
    {error && <p role="alert" className="text-[13px] text-danger">{error} <button type="button" className="underline" onClick={() => setRevision(value => value + 1)}>Retry</button></p>}
  </section>;
}
