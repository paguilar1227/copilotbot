import { useState } from 'react';
import { Download, BookOpen } from 'lucide-react';
import { api, useStore } from '@/state/store';
import { RosterDialog } from './RosterDialog';

export function ExportBotTemplate({ botId }: { botId: string }) {
  const { flushBotPatches } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const saveToRoster = async () => {
    setSaving(true); setError(''); setSaved(false);
    try {
      await flushBotPatches(botId);
      await api('/api/copilotbot/roster/bots', { method: 'POST', body: JSON.stringify({ botId }) });
      setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  const download = async () => {
    setSaving(true); setError('');
    try {
      await flushBotPatches(botId);
      const file = await api<{ filename: string; yaml: string }>(`/api/copilotbot/bots/${botId}/template`);
      const url = URL.createObjectURL(new Blob([file.yaml], { type: 'application/yaml' }));
      const link = document.createElement('a');
      link.href = url; link.download = file.filename; document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60_000); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  return <div className="mb-4 rounded-xl bg-card p-4">
    <button type="button" disabled={saving} onClick={() => void saveToRoster()} className="mb-2 flex items-center gap-2 rounded-lg bg-control px-3 py-2 text-[13px] text-ink disabled:opacity-50"><BookOpen size={15} />Save to roster</button>
    <button type="button" disabled={saving} onClick={() => void download()} className="flex items-center gap-2 rounded-lg bg-control px-3 py-2 text-[13px] text-ink disabled:opacity-50"><Download size={15} />Export YAML template</button>
    <p className="mt-2 text-[12px] text-ink-secondary">Reusable settings, routines and resource names. Excludes credentials, chat history, learned memory and local avatar files.</p>
    {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
    {saved && <p role="status" className="mt-2 text-[13px] text-success">Saved as a reusable bot template. <button type="button" onClick={() => setRosterOpen(true)} className="underline">Open roster</button></p>}
    {rosterOpen && <RosterDialog onClose={() => setRosterOpen(false)} />}
  </div>;
}
