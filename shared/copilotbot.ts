import { z } from 'zod';

export function azureEndpoint(value: string): string {
  if (!value.trim()) return '';
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || !/\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/.test(url.hostname)
    || !['/', '/openai/v1', '/openai/v1/'].includes(url.pathname)) {
    throw new Error('Use your Azure Foundry HTTPS resource endpoint, without a key, query, or deployment path.');
  }
  return url.origin;
}

const name = z.string().trim().refine(value => !/[\r\n\0]/.test(value), 'Use a name without control characters');
export const azureConfigSchema = z.object({
  endpoint: z.string().transform((value, ctx) => {
    try { return azureEndpoint(value); } catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }); return z.NEVER; }
  }).optional(),
  auth: z.enum(['entra', 'api-key']).optional(),
  key: z.string().optional(),
  tenant: name.optional(),
  subscription: name.optional(),
  resourceGroup: name.optional(),
  resourceName: name.optional(),
  models: z.array(name.min(1)).optional(),
  liveDeployment: name.optional(),
  realtimeDeployment: name.optional(),
  transcriptionDeployment: name.optional(),
  ttsDeployment: name.optional(),
}).strict();
export type AzureConfig = z.infer<typeof azureConfigSchema>;
export type AzureSettings = Omit<AzureConfig, 'key'> & { configured: boolean };

export function azureSettings(config: AzureConfig = {}): AzureSettings {
  const { key, ...publicSettings } = config;
  return { ...publicSettings, auth: config.auth ?? 'entra', configured: Boolean(config.endpoint && (config.auth !== 'api-key' || key?.trim())) };
}

export const AZURE_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] as const;
