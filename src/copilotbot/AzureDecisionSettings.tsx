import { useEffect, useState } from 'react';
import { api, useStore, type ConfigStatus } from '@/state/store';

export function AzureDecisionSettings() {
  const { state, dispatch } = useStore();
  const saved = state.config?.decider?.model ?? '';
  const [model, setModel] = useState(saved);
  const [deployments, setDeployments] = useState<Array<{ name: string; type: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  useEffect(() => { setModel(saved); }, [saved]);
  const action = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setResult('');
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    const config = await api<ConfigStatus>('/api/config', { method: 'PUT', body: JSON.stringify({ decider: { azureDeployment: model.trim() } }) });
    dispatch({ type: 'configStatus', config });
  };
  const button = 'rounded-lg border border-hairline/40 px-3 py-2 text-[13px] disabled:opacity-50';
  return <section aria-label="Azure decision model" className="space-y-3 px-4">
    <p className="text-[13px] text-ink-secondary">Uses your connection in Settings → AI → API keys → Azure Foundry, including Microsoft Entra ID. Choose a chat deployment that supports structured JSON output, such as gpt-4.1-mini when available.</p>
    <label className="block text-[13px]">Azure decision deployment
      <input aria-label="Azure decision deployment" list="azure-decision-deployments" value={model} onChange={event => setModel(event.target.value)} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2" />
      <datalist id="azure-decision-deployments">{deployments.filter(item => item.type === 'chat').map(item => <option key={item.name} value={item.name} />)}</datalist>
    </label>
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={busy} onClick={() => void action(async () => { setDeployments((await api<{ deployments: typeof deployments }>('/api/copilotbot/azure/deployments')).deployments); })}>Refresh Azure deployments</button>
      <button className={button} disabled={busy || !model.trim()} onClick={() => void action(async () => { await save(); setResult('Decision deployment saved. Run Test to verify it.'); })}>Save decision deployment</button>
      <button className={button} disabled={busy || !model.trim() || !state.config?.azure?.configured} onClick={() => void action(async () => {
        await save();
        const checked = await api<{ ok: boolean; latencyMs?: number; reason?: string; status?: number }>('/api/decider/test', { method: 'POST', body: '{}' });
        if (!checked.ok) {
          const reason = checked.reason === 'no_key' ? 'Azure sign-in or API key is unavailable. Check Azure CLI and the Azure Foundry connection.'
            : checked.reason === 'rejected' ? 'Azure refused access. Check the selected account and its permission to use this deployment.'
            : `Azure decision test failed: ${checked.reason ?? 'unknown'}. Check the deployment name and connection.`;
          throw new Error(`${reason}${checked.status ? ` (HTTP ${checked.status})` : ''}`);
        }
        setResult(`Azure answered in ${checked.latencyMs} ms. Slow or uncertain decisions fall back to the room lead.`);
      })}>Test Azure decision model</button>
    </div>
    <p className="text-[12px] text-ink-secondary">This test sends a small billable request. Chat-model probabilities are estimates; this is not Jev calibration.</p>
    {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    {result && <p role="status" className="text-[13px]">{result}</p>}
  </section>;
}
