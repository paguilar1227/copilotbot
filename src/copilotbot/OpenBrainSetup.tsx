import { useEffect, useRef, useState } from 'react';
import { api } from '@/state/store';
import type { BrainRuntimeStatus } from '../../server/copilotbot/open-brain-runtime';

/** Shared by onboarding and the workspace so setup can resume after a restart. */
export function OpenBrainSetup({ compact = false, onRuntimeChange }: { compact?: boolean; onRuntimeChange?: () => void }) {
  const [status, setStatus] = useState<BrainRuntimeStatus>();
  const [error, setError] = useState('');
  const [confirmRollback, setConfirmRollback] = useState(false);
  const revision = useRef<string | undefined>(undefined);
  const onChange = useRef(onRuntimeChange);
  useEffect(() => { onChange.current = onRuntimeChange; }, [onRuntimeChange]);
  useEffect(() => {
    let alive = true;
    const refresh = () => api('/api/copilotbot/open-brain/setup')
      .then(value => { if (alive) { setStatus(value); setError('');
        const next = value.updates?.current?.revision;
        if (next && revision.current && next !== revision.current) onChange.current?.();
        revision.current = next; } })
      .catch(() => { if (alive) setError('Could not check Open Brain setup. Reopen this panel to try again.'); });
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2000);
    return () => { alive = false; window.clearInterval(interval); };
  }, []);
  if (!status?.managed && !error) return null;
  if (compact && status?.phase === 'ready' && !status.updates) return null;
  const action = async (name: 'start' | 'docker' | 'wsl' | 'desktop' | 'check' | 'update' | 'rollback') => {
    setError(''); setConfirmRollback(false);
    try { setStatus(await api(`/api/copilotbot/open-brain/setup/${name}`, { method: 'POST' })); }
    catch { setError('Setup could not start. Please try again.'); }
  };
  const button = 'rounded-md border border-hairline px-3 py-1.5 text-[13px] hover:bg-raised disabled:opacity-50';
  return <section aria-label="Open Brain setup" className="m-3 rounded-xl border border-hairline bg-card p-4">
    <div className="flex items-center justify-between gap-3"><strong className="text-[14px]">Open Brain Lite</strong><span className="text-[12px] text-ink-secondary">{status?.phase === 'ready' ? 'Ready' : 'Setup'}</span></div>
    <p role="status" className="mt-2 text-[13px] text-ink-secondary">{(status?.phase === 'error' ? status.message : status?.updates?.message ?? status?.message) ?? 'Checking setup…'}</p>
    {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
    {status?.updates && <div className="mt-3 space-y-2">
      <p className="text-[12px] text-ink-secondary">Installed: {status.updates.current?.version ?? 'Bundled version'}</p>
      <div className="flex flex-wrap gap-2">
        <button className={button} disabled={status.busy || status.updates.checking} onClick={() => void action('check')}>{status.updates.checking ? 'Checking…' : 'Check for updates'}</button>
        {status.updates.available && <button className={button} disabled={status.busy || status.updates.recoveryRequired} onClick={() => void action('update')}>Update to {status.updates.available.version}</button>}
        {(status.updates.rollback || status.updates.recoveryRequired) && <button className={button} disabled={status.busy} onClick={() => setConfirmRollback(true)}>{status.updates.recoveryRequired ? 'Recover Open Brain' : 'Roll back'}</button>}
      </div>
      {status.updates.available && <p className="text-[12px] text-ink-secondary">A local backup is created before updating. Open Brain writes pause during installation.</p>}
      {confirmRollback && <div role="alert" className="rounded-lg border border-hairline p-3 text-[13px]">
        <p>Restore Open Brain {status.updates.rollback?.version ?? 'from the last working backup'}{status.updates.rollback ? ' from ' + new Date(status.updates.rollback.createdAt).toLocaleString() : ''}? Notes, tasks and files return to that snapshot. Your current state is backed up before rollback.</p>
        <div className="mt-2 flex gap-2"><button className={button} onClick={() => void action('rollback')}>Restore backup</button><button className={button} onClick={() => setConfirmRollback(false)}>Cancel</button></div>
      </div>}
    </div>}
    {status?.phase !== 'ready' && <div className="mt-3 flex flex-wrap gap-2">
      {status?.windows && status.managed && <>
        {['docker-stopped', 'restart-required'].includes(status.phase) && <button className={button} disabled={status.busy} onClick={() => void action('desktop')}>Start Docker Desktop</button>}
        {status.phase === 'docker-missing' && <button className={button} disabled={status.busy} onClick={() => void action('docker')}>Install Docker Desktop</button>}
        <button className={button} disabled={status.busy} onClick={() => void action('wsl')}>Enable or update WSL</button>
      </>}
      <button className={button} disabled={status?.busy} onClick={() => void action('start')}>{status?.busy ? 'Setup in progress…' : 'Check again / start Open Brain'}</button>
    </div>}
    {status?.windows && status.phase !== 'ready' && <p className="mt-3 text-[12px] text-ink-tertiary">Docker Desktop and WSL 2 run the local database and models. Windows may ask for administrator access or a restart. Docker’s installer shows its license terms. Your data survives app updates and restarts.</p>}
  </section>;
}
