import { azureEndpoint, type AzureConfig } from '../../shared/copilotbot.ts';
import { azureCredential, type AzureRunner } from './azure-auth.ts';
import { openrouterRequestBody } from '../decider/openrouter.ts';
import { parseJevResponse, questionsFit, refusal } from '../decider/jev.ts';
import type { DeciderBackend } from '../decider/types.ts';

export function createAzureDecider(config: () => AzureConfig, runner?: AzureRunner): DeciderBackend {
  let active: AzureConfig | undefined;
  let credential: ReturnType<typeof azureCredential>;
  return {
    id: 'azure',
    async decide(request) {
      const settings = config();
      if (!request.model?.trim() || !settings.endpoint || !questionsFit(request.questions)) return { ok: false, reason: 'misconfigured' };
      let endpoint: string;
      try { endpoint = azureEndpoint(settings.endpoint); } catch { return { ok: false, reason: 'misconfigured' }; }
      if (!active || JSON.stringify(active) !== JSON.stringify(settings)) {
        active = structuredClone(settings);
        credential = azureCredential(settings, runner);
      }
      let headers: Record<string, string>;
      try { headers = await credential!.headers(); } catch { return { ok: false, reason: 'no_key' }; }
      if (request.signal.aborted) return { ok: false, reason: 'cancelled' };
      const { provider: _provider, temperature: _temperature, max_tokens, ...body } = openrouterRequestBody(request.state, request.questions, request.model);
      let response: Response;
      try {
        response = await request.fetch(`${endpoint}/openai/v1/chat/completions`, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, max_completion_tokens: max_tokens }), signal: request.signal, redirect: 'error',
        });
      } catch { return { ok: false, reason: 'unreachable' }; }
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return refusal(response.status); }
      try {
        const result = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number } };
        const parsed = parseJevResponse(JSON.parse(result.choices?.[0]?.message?.content ?? ''), request.questions);
        if (!parsed.ok) return { ok: false, reason: 'malformed' };
        const tokens = result.usage?.prompt_tokens;
        return { ...parsed, model: request.model,
          ...(typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0 ? { inputTokens: tokens } : {}) };
      } catch { return { ok: false, reason: 'malformed' }; }
    },
  };
}
