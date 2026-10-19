import { useEffect, useState } from 'react';
import { api } from '@/state/store';
import type { BrainRuntimeStatus } from '../../server/copilotbot/open-brain-runtime';

/** Shared by onboarding and the workspace so setup can resume after a restart. */
export function OpenBrainSetup({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<BrainRuntimeStatus>();
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const refresh = () => api('/api/copilotbot/open-brain/setup')
      .then(value => { if (alive) { setStatus(value); setError(''); } })
      .catch(() => { if (alive) setError('Could not check Open Brain setup. Reopen this panel to try again.'); });
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2000);
    return () => { alive = false; window.clearInterval(interval); };
  }, []);
  if (!status?.managed && !error) return null;
  if (compact && status?.phase === 'ready') return null;
  const action = async (name: 'start' | 'docker' | 'wsl' | 'desktop') => {
    setError('');
    try { setStatus(await api(`/api/copilotbot/open-brain/setup/${name}`, { method: 'POST' })); }
    catch { setError('Setup could not start. Please try again.'); }
  };
  const button = 'rounded-md border border-hairline px-3 py-1.5 text-[13px] hover:bg-raised disabled:opacity-50';
  return <section aria-label="Open Brain setup" className="m-3 rounded-xl border border-hairline bg-card p-4">
    <div className="flex items-center justify-between gap-3"><strong className="text-[14px]">Open Brain Lite</strong><span className="text-[12px] text-ink-secondary">{status?.phase === 'ready' ? 'Ready' : 'Setup'}</span></div>
    <p role="status" className="mt-2 text-[13px] text-ink-secondary">{status?.message ?? 'Checking setup…'}</p>
    {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
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
