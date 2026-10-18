import { z } from 'zod';

const id = z.string().regex(/^[a-z][a-z0-9-]*$/);
const relativeFile = z.string().min(1).refine(value => !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..'), 'Use a relative path inside the plugin');
const setting = z.object({
  type: z.enum(['text', 'url', 'boolean', 'secret']), label: z.string().min(1),
  description: z.string().optional(), default: z.union([z.string(), z.boolean()]).optional(), required: z.boolean().default(false),
}).strict();

/** Versioned extension contract. Backend code is trusted local Node code; only the page is sandboxed. */
export const pluginManifestSchema = z.object({
  format: z.literal('copilotbot.plugin'), apiVersion: z.literal(1), id,
  name: z.string().min(1), version: z.string().regex(/^\d+\.\d+\.\d+$/), description: z.string().min(1),
  backend: relativeFile.optional(),
  pages: z.array(z.object({ id, title: z.string().min(1), entry: relativeFile, webApp: z.object({ service: id, module: relativeFile }).strict().optional() }).strict()).default([]),
  commands: z.array(z.object({ id, title: z.string().min(1) }).strict()).default([]),
  settings: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/), setting).default({}),
  services: z.record(id, z.object({ urlSetting: z.string(), tokenSetting: z.string().optional() }).strict()).default({}),
  mcp: z.array(z.object({ name: z.string().regex(/^plugin_[a-z0-9_-]{1,25}$/), service: id, path: z.string().startsWith('/') }).strict()).default([]),
  skills: z.array(z.object({ name: id, file: relativeFile, description: z.string().min(1) }).strict()).default([]),
}).strict().superRefine((manifest, ctx) => {
  for (const key of ['pages', 'commands', 'mcp', 'skills'] as const) {
    const names = manifest[key].map(row => 'id' in row ? row.id : row.name);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: `Duplicate ${key}` });
  }
  for (const service of Object.values(manifest.services)) {
    if (manifest.settings[service.urlSetting]?.type !== 'url' || (service.tokenSetting && manifest.settings[service.tokenSetting]?.type !== 'secret')) ctx.addIssue({ code: 'custom', message: 'Services require a URL setting and an optional secret setting' });
  }
  for (const field of Object.values(manifest.settings)) if (field.type === 'secret' && field.default !== undefined) ctx.addIssue({ code: 'custom', message: 'Secret defaults cannot be published in a manifest' });
  for (const page of manifest.pages) if (page.webApp && !manifest.services[page.webApp.service]) ctx.addIssue({ code: 'custom', message: 'Unknown web app service' });
  for (const mcp of manifest.mcp) if (!manifest.services[mcp.service]) ctx.addIssue({ code: 'custom', message: 'Unknown MCP service' });
  if (manifest.commands.length && !manifest.backend) ctx.addIssue({ code: 'custom', message: 'Commands require a backend' });
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginSettings = Record<string, string | boolean>;
export interface PluginListing {
  manifest: PluginManifest;
  enabled: boolean;
  status: 'disabled' | 'starting' | 'ready' | 'error';
  error?: string;
  settings: PluginSettings;
  configuredSecrets: string[];
}

/** Messages cross an opaque-origin iframe boundary; the parent validates source, channel, and declared command. */
export interface PluginPageRequest { type: 'copilotbot:command'; channel: string; id: string; command: string; input?: unknown }
