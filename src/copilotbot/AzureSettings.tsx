import { useEffect, useState } from 'react';
import { api, useStore, type ConfigStatus } from '@/state/store';
import type { AzureConfig } from '../../shared/copilotbot';
import { DeviceSignIn } from '@/components/DeviceSignIn';

type Deployment = { name: string; model: string; type: string };
type Resource = { name: string; resourceGroup: string; endpoint: string };
const inputClass = 'w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink';
const buttonClass = 'rounded-lg bg-control px-3 py-2 text-[12px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50';

export function AzureSettings({ onSaved }: { onSaved?: () => void }) {
  const { state, dispatch, refreshInstances, refreshModels } = useStore();
  const saved = state.config?.azure;
  const [draft, setDraft] = useState<AzureConfig>(saved ?? { auth: 'entra' });
  const [key, setKey] = useState('');
  const [modelsText, setModelsText] = useState((saved?.models ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [resources, setResources] = useState<Resource[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  useEffect(() => { setDraft(saved ?? { auth: 'entra' }); setModelsText((saved?.models ?? []).join(', ')); }, [saved]);
  const patch = (value: Partial<AzureConfig>) => setDraft(old => ({ ...old, ...value }));
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null); setMessage('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const save = async (value = draft) => {
    const { configured: _configured, ...settings } = { ...value, models: modelsText.split(',').map(s => s.trim()).filter(Boolean) } as AzureConfig & { configured?: boolean };
    let status = await api<ConfigStatus>('/api/config', { method: 'PUT', body: JSON.stringify({ azure: settings }) });
    if (value.auth === 'api-key' && key.trim()) {
      status = window.ogb?.setCredential
        ? await window.ogb.setCredential('azureFoundryKey', key.trim())
        : await api<ConfigStatus>('/api/config', { method: 'PUT', body: JSON.stringify({ azure: { key: key.trim() } }) });
      setKey('');
    }
    dispatch({ type: 'configStatus', config: status });
    await refreshInstances();
    await refreshModels('azure');
    setMessage('Azure Foundry settings saved.');
    onSaved?.();
  };
  const selectResource = async (resource: Resource) => {
    const next = { ...draft, endpoint: resource.endpoint, resourceGroup: resource.resourceGroup, resourceName: resource.name };
    setDraft(next);
    await save(next);
    const result = await api<{ deployments: Deployment[] }>('/api/copilotbot/azure/deployments');
    setDeployments(result.deployments);
  };
  return <section className="space-y-3 rounded-xl border border-hairline p-3" aria-label="Azure Foundry settings">
    <div className="text-[14px] font-semibold">Azure Foundry</div>
    <p className="text-[12px] text-ink-secondary">One connection for models, Live calls and text-to-speech. Choose deployment names from your Azure resource.</p>
    <label className="block text-[12px]">Authentication
      <select className={inputClass} value={draft.auth ?? 'entra'} onChange={e => { patch({ auth: e.target.value as 'entra' | 'api-key' }); setKey(''); }}>
        <option value="entra">Microsoft Entra ID — no API key</option><option value="api-key">Azure API key</option>
      </select>
    </label>
    {draft.auth !== 'api-key' && <>
      <p className="text-[12px] text-ink-secondary">Requires Azure CLI on the computer running the bot. Existing az login is reused. Your account needs permission to invoke these deployments.</p>
      <DeviceSignIn instanceId="azure" provider="azure" onDone={() => void refreshInstances()} />
      <button className={buttonClass} disabled={busy} onClick={() => void run(async () => { await save(); const result = await api<{ resources: Resource[] }>('/api/copilotbot/azure/resources'); setResources(result.resources); if (!result.resources.length) setMessage('No Azure AI resources found in this subscription.'); })}>Find my Azure resources</button>
    </>}
    {resources.length > 0 && <label className="block text-[12px]">Resource<select className={inputClass} value={draft.resourceName ?? ''} onChange={e => { const resource = resources.find(r => r.name === e.target.value); if (resource) void run(() => selectResource(resource)); }}>
      <option value="">Choose a resource</option>{resources.map(r => <option key={r.name} value={r.name}>{r.name} · {r.resourceGroup}</option>)}
    </select></label>}
    <label className="block text-[12px]">Resource endpoint<input aria-label="Azure resource endpoint" className={inputClass} value={draft.endpoint ?? ''} onChange={e => patch({ endpoint: e.target.value })} placeholder="https://your-resource.openai.azure.com" /></label>
    {draft.auth === 'api-key' && <label className="block text-[12px]">API key<input type="password" autoComplete="off" className={inputClass} value={key} onChange={e => setKey(e.target.value)} placeholder={saved?.configured ? 'Saved — paste to replace' : 'Paste Azure resource key'} /></label>}
    <details><summary className="cursor-pointer text-[12px]">Tenant, subscription and deployment discovery</summary>
      {(['tenant', 'subscription', 'resourceGroup', 'resourceName'] as const).map(field => <label key={field} className="block text-[12px]">{field}<input className={inputClass} value={draft[field] ?? ''} onChange={e => patch({ [field]: e.target.value })} /></label>)}
    </details>
    <label className="block text-[12px]">Chat deployments (comma separated)<input aria-label="Azure chat deployments" className={inputClass} value={modelsText} onChange={e => setModelsText(e.target.value)} placeholder="my-chat-deployment" /></label>
    {(['liveDeployment', 'realtimeDeployment', 'transcriptionDeployment', 'ttsDeployment'] as const).map((field, index) => <label key={field} className="block text-[12px]">{['GPT-Live deployment', 'Alternative Realtime deployment', 'Realtime transcription deployment', 'Text-to-speech deployment'][index]}
      <input aria-label={['GPT-Live deployment', 'Alternative Realtime deployment', 'Realtime transcription deployment', 'Text-to-speech deployment'][index]} className={inputClass} value={draft[field] ?? ''} onChange={e => patch({ [field]: e.target.value })} list={`azure-${field}`} />
      <datalist id={`azure-${field}`}>{deployments.filter(d => d.type === ['live', 'realtime', 'transcription', 'tts'][index]).map(d => <option key={d.name} value={d.name} />)}</datalist>
    </label>)}
    <p className="text-[12px] text-ink-secondary">Use a GPT-Live deployment for Live calls. Alternatively, use a conversational Realtime deployment plus a transcription deployment. GPT-Live includes its own transcription.</p>
    <div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={busy} onClick={() => void run(() => save())}>{busy ? 'Saving…' : 'Save Azure settings'}</button>
      <button className={buttonClass} disabled={busy} onClick={() => void run(async () => { await save(); const result = await api<{ deployments: Deployment[] }>('/api/copilotbot/azure/deployments'); setDeployments(result.deployments); setMessage(`${result.deployments.length} deployments found.`); })}>Refresh deployments</button></div>
    {message && <p role="status" className="text-[12px] text-success">{message}</p>}
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
  </section>;
}
