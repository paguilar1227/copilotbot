import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { botDefaultsProfileSchema, botRoutineTemplateSchema, newBotDefaultsSchema } from '../new-bot-defaults.ts';
import type { BotRecord } from '../store.ts';
import type { NewBotDefaults } from '../../shared/new-bot-defaults.ts';
import { resourceAccessSchema, type ResourceAccess } from './resource-access.ts';

const templateProfile = botDefaultsProfileSchema.omit({ avatarUrl: true, peers: true, mcpServers: true, skillAccess: true });
export const botTemplateSchema = z.object({
  format: z.literal('copilotbot/bot'),
  version: z.literal(1),
  profile: templateProfile.default({}),
  skills: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64)).default([]),
  resources: resourceAccessSchema.default({ skills: null, mcpServers: null }),
  routines: z.array(botRoutineTemplateSchema.omit({ attachments: true })).max(100).default([]),
}).strict();
export type BotTemplate = z.infer<typeof botTemplateSchema>;

export function parseBotTemplate(yaml: string): { template: BotTemplate; defaults: NewBotDefaults } {
  if (Buffer.byteLength(yaml, 'utf8') > 900_000) throw new Error('Bot template must fit within 900 KB');
  const document = parseDocument(yaml, { uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error(document.errors[0]?.message ?? document.warnings[0]!.message);
  const template = botTemplateSchema.parse(document.toJS({ maxAliasCount: 0 }));
  const defaults = newBotDefaultsSchema.parse({
    profile: { ...template.profile, skillAccess: template.resources.skills, mcpServers: template.resources.mcpServers },
    routines: template.routines, librarySkills: template.skills,
  });
  return { template, defaults };
}

export function exportBotTemplate(bot: BotRecord, resources: ResourceAccess, routines: unknown[] = [], skills: string[] = []): string {
  const profile: Record<string, unknown> = {};
  for (const key of Object.keys(templateProfile.shape)) {
    const value = bot[key as keyof BotRecord];
    if (value !== undefined) profile[key] = value;
  }
  if (!profile.approvalMode) profile.approvalMode = bot.autoApprove ? 'auto' : 'ask';
  const portableRoutines = routines.map(routine => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(botRoutineTemplateSchema.shape)) {
      if (key !== 'attachments' && routine && typeof routine === 'object' && key in routine) out[key] = (routine as Record<string, unknown>)[key];
    }
    return out;
  });
  return '# CopilotBot template. Review settings before creating a bot.\n' + stringify(botTemplateSchema.parse({
    format: 'copilotbot/bot', version: 1, profile, skills, resources, routines: portableRoutines,
  }));
}
