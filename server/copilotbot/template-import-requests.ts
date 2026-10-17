import { z } from 'zod';
import { newId } from '../contracts.ts';
import { redactSecretsInText } from '../redact.ts';
import type { Store, BotRecord, OptionCardData } from '../store.ts';
import type { TemplateImportRequest } from '../../shared/bot-template.ts';
import type { BotCreationResult } from '../routes/bots-create.ts';
import type { NewBotDefaults } from '../../shared/new-bot-defaults.ts';
import { previewBotTemplates } from './bot-templates.ts';

export const templateImportInput = z.object({
  files: z.array(z.object({ filename: z.string().min(1), yaml: z.string() }).strict()).min(1),
  reason: z.string().trim().min(1),
  preview_only: z.boolean().optional(),
}).strict();

interface ImportDependencies {
  store: Store;
  canPersist(botId: string, threadId: string): { ok: true } | { ok: false; status: number; error: string };
  canAccessTeam(bot: BotRecord, section?: string): boolean;
  create(defaults: NewBotDefaults, validateOnly?: boolean): Promise<BotCreationResult>;
}

export class TemplateImportRequests {
  private readonly resolving = new Set<string>();
  private readonly deps: ImportDependencies;
  constructor(deps: ImportDependencies) { this.deps = deps; }

  async propose(botId: string, threadId: string, input: unknown, from?: { botId: string; name: string; color: string }, canCommit: () => boolean = () => true) {
    const checkedInput = templateImportInput.safeParse(input);
    if (!checkedInput.success) throw Object.assign(new Error(checkedInput.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n')), { status: 400 });
    const body = checkedInput.data;
    const permission = this.deps.canPersist(botId, threadId);
    if (!permission.ok) throw Object.assign(new Error(permission.error), { status: permission.status });
    const bot = this.deps.store.bot(botId)!;
    const previews = previewBotTemplates(body.files);
    if (body.preview_only || previews.some(item => !item.defaults)) return { state: 'preview', templates: previews, error: previews.some(item => !item.defaults) ? 'Fix all invalid templates before requesting import. No bots were created.' : undefined };
    const entries: TemplateImportRequest['entries'] = [];
    for (const item of previews) {
      const defaults = structuredClone(item.defaults!);
      defaults.profile.section ??= bot.section ?? '';
      if (defaults.profile.section !== (bot.section ?? '') && !this.deps.canAccessTeam(bot, defaults.profile.section)) {
        throw Object.assign(new Error(`You cannot import into team “${defaults.profile.section}”. Ask the user to import it in the app.`), { status: 403 });
      }
      // A template describes preferences, never consent to run scheduled work or gain execution privileges.
      const warnings: string[] = [];
      if (defaults.profile.approvalMode && defaults.profile.approvalMode !== 'ask') warnings.push('Permissions start at Ask. Change them in bot settings after import.');
      defaults.profile.approvalMode = 'ask';
      defaults.profile.alwaysAllow = [];
      if (defaults.profile.chiefOfStaff || defaults.profile.managedSections?.length) warnings.push('Chief and additional team access require setup in the app after import.');
      defaults.profile.chiefOfStaff = false;
      defaults.profile.managedSections = [];
      defaults.routines = defaults.routines.map(routine => ({ ...routine, enabled: false }));
      const existing = this.deps.store.bots.some(candidate => !candidate.hidden && (candidate.section ?? '') === defaults.profile.section && candidate.name.toLowerCase() === defaults.profile.name!.toLowerCase());
      const repeated = entries.some(entry => entry.defaults.profile.section === defaults.profile.section && entry.defaults.profile.name!.toLowerCase() === defaults.profile.name!.toLowerCase());
      if (existing || repeated) throw new Error(`A bot named “${defaults.profile.name}” already exists in this team or import. Rename it before importing.`);
      const checked = await this.deps.create(defaults, true);
      if (checked.status >= 400) throw new Error(`${item.filename}: ${checked.body.error}`);
      entries.push({ filename: `${item.filename} · document ${item.document}`, defaults, state: 'ready', warnings });
    }
    if (!canCommit()) throw Object.assign(new Error("The requesting turn expired. No import was proposed."), { status: 401 });
    const requestId = newId();
    const request: TemplateImportRequest = { botId, threadId, entries };
    const card: OptionCardData = {
      requestId, tool: 'import_bot_templates', title: `Import ${entries.length} ${entries.length === 1 ? 'bot' : 'bots'}?`,
      subtitle: redactSecretsInText([body.reason, 'Review these settings. New bots start at Ask, with schedules paused. Credentials and permission grants are not imported.', ...entries.map(entry => `${entry.filename}\n${JSON.stringify(entry.defaults, null, 2)}\n${entry.warnings?.join('\n') ?? ''}`)].join('\n\n')),
      options: ['Import bots', 'Cancel'], templateImportRequest: request,
    };
    const message = this.deps.store.appendMessage(threadId, { role: 'bot', kind: 'options', ...(from ? { from } : {}), card });
    return { state: 'pending', requestId, messageId: message.id, title: card.title, warnings: entries.flatMap(entry => entry.warnings ?? []) };
  }

  async resolve(args: { botId: string; threadId: string; requestId: string; behavior: string }) {
    const message = this.deps.store.messagesFor(args.threadId).find(item => item.card?.requestId === args.requestId && item.card.templateImportRequest);
    if (!message?.card?.templateImportRequest) return null;
    const card = message.card;
    const request = structuredClone(card.templateImportRequest!);
    if (request.botId !== args.botId || request.threadId !== args.threadId) throw Object.assign(new Error('This import belongs to another conversation'), { status: 403 });
    if (!['allow', 'deny'].includes(args.behavior)) throw new Error('Confirm or cancel this import');
    if (card.answered || card.dismissed || card.expired) return { request, messageId: message.id, duplicate: true };
    if (this.resolving.has(args.requestId)) throw Object.assign(new Error('This import is already running'), { status: 409 });
    this.resolving.add(args.requestId);
    const save = () => this.deps.store.patchMessage(args.threadId, message.id, { card: { ...card, templateImportRequest: structuredClone(request) } });
    try {
      const permission = this.deps.canPersist(args.botId, args.threadId);
      if (!permission.ok) throw new Error(permission.error);
      if (args.behavior === 'deny') request.result = 'denied';
      else {
        for (const entry of request.entries) {
          if (entry.state === 'created' || entry.state === 'failed') continue;
          if (entry.state === 'importing') { entry.state = 'failed'; entry.error = 'Import was interrupted. Check the bot list before retrying this template.'; continue; }
          try {
            const sender = this.deps.store.bot(args.botId);
            if (!sender || sender.hidden || (entry.defaults.profile.section !== (sender.section ?? '') && !this.deps.canAccessTeam(sender, entry.defaults.profile.section))) throw new Error('Team access changed; import cancelled.');
            const name = entry.defaults.profile.name!;
            if (this.deps.store.bots.some(bot => !bot.hidden && (bot.section ?? '') === entry.defaults.profile.section && bot.name.toLowerCase() === name.toLowerCase())) throw new Error(`“${name}” already exists. Rename it before retrying.`);
            entry.state = 'importing'; save();
            const result = await this.deps.create(entry.defaults);
            if (result.status >= 400 || !result.body.bot) throw new Error(result.body.error ?? 'The bot could not be created');
            entry.state = 'created'; entry.botId = result.body.bot.id; entry.warnings?.push(...result.body.warnings ?? []);
          } catch (error) { entry.state = 'failed'; entry.error = redactSecretsInText(error instanceof Error ? error.message : String(error)); }
          save();
        }
        const created = request.entries.filter(entry => entry.state === 'created').length;
        request.result = created === request.entries.length ? 'applied' : created ? 'partial' : 'failed';
      }
      this.deps.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: request.result === 'denied' ? 'deny' : 'allow', options: [], templateImportRequest: request,
        title: request.result === 'denied' ? 'Bot import cancelled' : `Imported ${request.entries.filter(entry => entry.state === 'created').length} of ${request.entries.length} bots`,
        held: request.entries.filter(entry => entry.error).map(entry => `${entry.filename}: ${entry.error}`).join('\n') || undefined,
      } });
      return { request, messageId: message.id, duplicate: false };
    } finally { this.resolving.delete(args.requestId); }
  }
}
