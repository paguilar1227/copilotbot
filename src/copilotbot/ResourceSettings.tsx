import { useEffect, useState } from 'react';
import { useBotEditor } from '@/components/bot-settings/BotEditorContext';
import { api, useStore, type Bot } from '@/state/store';
import { Select } from '@/components/Select';
import type { ResourceAccess, ResourceState } from '../../shared/bot-resources';

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
  const busy = bot ? !!bot.busy : state.bots.some(member => (member.section ?? "") === (team ?? "") && member.busy);
  const disabled = saving || busy;
  return <section className="space-y-4" aria-label="Resource access">
    <p className="text-[13px] text-ink-secondary">{bot
      ? 'Choose the app-managed skills and MCP servers this bot can use. Team limits also apply. Skills must be installed and enabled.'
      : 'Team limits apply to every member, including bots added later. Each bot can select a smaller set. Skills must also be assigned and enabled for that bot.'}</p>
    {data && (['skills', 'mcpServers'] as const).map(kind => {
      const label = kind === 'skills' ? 'Skills' : 'MCP servers';
      const selected = data.policy[kind];
      const mode = selected === null ? 'all' : selected.length === 0 ? 'none' : 'selected';
      const inherited = data.inherited[kind];
      const known = data.catalog[kind];
      const knownNames = new Set(known.map(row => row.name));
      const selectedNames = selected === null ? null : new Set(selected);
      const inheritedNames = inherited === null ? null : new Set(inherited);
      const rows = [...known, ...(selected ?? []).filter(name => !knownNames.has(name)).map(name => ({ name, enabled: false }))];
      return <fieldset key={kind} aria-label={label} disabled={disabled} className="rounded-xl bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[15px] font-medium text-ink">{label}</span>
          <Select aria-label={`${label} access`} value={mode} onChange={event => {
            const value = event.target.value;
            void save({ ...data.policy, [kind]: value === 'all' ? null : value === 'none' ? [] : known.filter(row => row.enabled && (inheritedNames === null || inheritedNames.has(row.name))).map(row => row.name) });
          }}>
            <option value="all">All available</option><option value="selected">Selected only</option><option value="none">None</option>
          </Select>
        </div>
        {inherited !== null && <p className="mt-2 text-[12px] text-ink-secondary">Team allows: {inherited.length ? inherited.join(', ') : 'none'}.</p>}
        {!rows.length && <p className="mt-3 text-[13px] text-ink-secondary">No {label.toLowerCase()} configured yet.</p>}
        <div className="mt-2 divide-y divide-hairline/40">
          {rows.map(row => {
            const teamAllows = inheritedNames === null || inheritedNames.has(row.name);
            const checked = selectedNames === null ? row.enabled : selectedNames.has(row.name);
            return <label key={row.name} className="flex items-start gap-3 py-2 text-[13px] text-ink">
              <input type="checkbox" aria-label={`Allow ${kind === 'skills' ? 'skill' : 'MCP'} ${row.name}`} className="mt-1" checked={checked && teamAllows}
                disabled={disabled || !teamAllows || (!row.enabled && !selectedNames?.has(row.name))} onChange={event => {
                  const current = selected ?? known.filter(item => item.enabled).map(item => item.name);
                  void save({ ...data.policy, [kind]: event.target.checked ? [...new Set([...current, row.name])] : current.filter(name => name !== row.name) });
                }} />
              <span className="min-w-0 break-words"><span className="font-medium">{row.name}</span>
                {!teamAllows ? <span className="block text-[12px] text-ink-secondary">Not allowed by team</span> : !row.enabled ? <span className="block text-[12px] text-ink-secondary">Missing or disabled — install and review before use</span> : null}
              </span>
            </label>;
          })}
        </div>
      </fieldset>;
    })}
    {!data && !error && <p role="status" className="text-[13px] text-ink-secondary">Loading resources…</p>}
    {disabled && <p role="status" className="text-[12px] text-ink-secondary">{saving ? 'Saving…' : 'Stop the affected bots to change resource access.'}</p>}
    {error && <p role="alert" className="text-[13px] text-danger">{error} <button type="button" className="underline" onClick={() => setRevision(value => value + 1)}>Retry</button></p>}
  </section>;
}
