import { LineCounter, parseAllDocuments, parseDocument, stringify, type Document } from 'yaml';
import type { BotTemplatePreview, TemplateDiagnostic, TemplateSource } from '../../shared/bot-template.ts';
import { z } from 'zod';
import { botDefaultsProfileSchema, botRoutineTemplateSchema, newBotDefaultsSchema } from '../new-bot-defaults.ts';
import type { BotRecord } from '../store.ts';
import type { NewBotDefaults } from '../../shared/new-bot-defaults.ts';
import { fitsOnOneLine } from '../bot-profile.ts';
import { resourceAccessSchema, type ResourceAccess } from './resource-access.ts';

const templateProfile = botDefaultsProfileSchema.omit({ avatarUrl: true, peers: true, mcpServers: true, skillAccess: true });
export const botTemplateSchema = z.object({
  format: z.literal('copilotbot/bot'),
  version: z.literal(1),
  profile: templateProfile.extend({ name: z.string().trim().min(1, 'Give the bot a name').max(100).refine(fitsOnOneLine, 'name must fit on one line') }),
  skills: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64)).default([]),
  resources: resourceAccessSchema.default({ skills: null, mcpServers: null }),
  routines: z.array(botRoutineTemplateSchema.omit({ attachments: true })).max(100).default([]),
}).strict();
export type BotTemplate = z.infer<typeof botTemplateSchema>;

export class BotTemplateError extends Error {
  readonly diagnostics: TemplateDiagnostic[];
  constructor(diagnostics: TemplateDiagnostic[]) {
    super(diagnostics.map(item => `${item.path}${item.line ? ` (line ${item.line}, column ${item.column})` : ''}: ${item.message}`).join('\n'));
    this.diagnostics = diagnostics;
  }
}

function readDocument(document: Document, lines: LineCounter) {
  if (document.errors.length || document.warnings.length) {
    throw new BotTemplateError([...document.errors, ...document.warnings].map(issue => ({ path: 'YAML', message: issue.message, line: lines.linePos(issue.pos[0]).line, column: lines.linePos(issue.pos[0]).col })));
  }
  let raw: unknown;
  try { raw = document.toJS({ maxAliasCount: 0 }); }
  catch { throw new BotTemplateError([{ path: 'YAML', message: 'Aliases are not supported. Write each value explicitly.' }]); }
  const checked = botTemplateSchema.safeParse(raw);
  if (!checked.success) throw new BotTemplateError(checked.error.issues.map(issue => {
    const node = document.getIn(issue.path, true) as { range?: number[] } | undefined;
    const position = node?.range ? lines.linePos(node.range[0]) : undefined;
    const path = issue.path.join('.') || 'template';
    const message = path === 'format' ? 'Use format: copilotbot/bot.'
      : path === 'version' ? 'Use version: 1.'
      : path === 'profile.name' && (issue.code === 'invalid_type' || issue.code === 'too_small') ? 'Required. Enter a non-empty bot name under profile.name.'
      : path === 'profile' && issue.code === 'invalid_type' ? 'Required. Add a profile object with a name.'
      : issue.message;
    return { path, message, ...(position ? { line: position.line, column: position.col } : {}) };
  }));
  const template = checked.data;
  const defaults = newBotDefaultsSchema.parse({
    profile: { ...template.profile, skillAccess: template.resources.skills, mcpServers: template.resources.mcpServers },
    routines: template.routines, librarySkills: template.skills,
  });
  return { template, defaults };
}

export function parseBotTemplate(yaml: string): { template: BotTemplate; defaults: NewBotDefaults } {
  if (Buffer.byteLength(yaml, 'utf8') > 900_000) throw new BotTemplateError([{ path: 'file', message: 'Bot template must fit within 900 KB' }]);
  const lines = new LineCounter();
  return readDocument(parseDocument(yaml, { uniqueKeys: true, lineCounter: lines }), lines);
}

/** Each document is independent; one malformed file must not hide errors in the others. */
export function previewBotTemplates(sources: TemplateSource[], warnings: (template: BotTemplate) => string[] = () => []): BotTemplatePreview[] {
  return sources.flatMap((source, fileIndex) => {
    const failure = (document: number, error: unknown): BotTemplatePreview => ({
      id: `${fileIndex}:${document}`, filename: source.filename, document,
      diagnostics: error instanceof BotTemplateError ? error.diagnostics : [{ path: 'template', message: error instanceof Error ? error.message : String(error) }], warnings: [],
    });
    if (Buffer.byteLength(source.yaml, 'utf8') > 900_000) return [failure(1, new Error('Bot template must fit within 900 KB'))];
    const lines = new LineCounter();
    try {
      const documents = parseAllDocuments(source.yaml, { uniqueKeys: true, lineCounter: lines });
      if (!documents.length) return [failure(1, new Error('The file is empty. Add format, version, and profile.name.'))];
      return documents.map((document, index) => {
        try {
          const parsed = readDocument(document, lines);
          return { id: `${fileIndex}:${index + 1}`, filename: source.filename, document: index + 1, defaults: parsed.defaults, warnings: warnings(parsed.template), diagnostics: [] };
        } catch (error) { return failure(index + 1, error); }
      });
    } catch (error) { return [failure(1, error)]; }
  });
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
