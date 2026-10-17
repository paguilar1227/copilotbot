import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import { writeFileAtomic } from '../atomic.ts';
import { botTemplateSchema, type BotTemplate } from './bot-templates.ts';
import { resourceAccessSchema } from './resource-access.ts';
import { SECTION_CONTEXT_MAX_BYTES } from '../section-context.ts';
import type { RosterDeployment, TeamTemplateDefinition } from '../../shared/roster.ts';

const id = z.string().uuid();
const ids = z.array(id).refine(values => new Set(values).size === values.length, 'Choose each bot template only once');
const responder = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mentions') }).strict(), z.object({ kind: z.literal('everyone') }).strict(),
  z.object({ kind: z.literal('member'), botId: id }).strict(), z.object({ kind: z.literal('auto'), fallbackBotId: id.optional() }).strict(),
]);
export const teamTemplateSchema = z.object({
  name: z.string().trim().min(1).max(60), description: z.string().default(''),
  members: ids.refine(values => values.length > 0, 'Choose at least one bot template'),
  resources: resourceAccessSchema, instructions: z.string().refine(value => Buffer.byteLength(value) <= SECTION_CONTEXT_MAX_BYTES, 'Team instructions are too long').default(''),
  peers: z.record(id, ids.nullable()).default({}),
  rooms: z.array(z.object({ name: z.string().trim().min(1).max(100), members: ids.refine(values => values.length > 0, 'A chat needs at least one member'), bulletin: z.string().max(12_000), responder, cwd: z.string().max(4096).optional() }).strict()).default([]),
}).strict().superRefine((value, ctx) => {
  const members = new Set(value.members);
  const check = (ids: string[], path: (string | number)[]) => { if (ids.some(id => !members.has(id))) ctx.addIssue({ code: 'custom', path, message: 'References a bot outside this team. Remove it from the chat or peer settings first.' }); };
  for (const [member, peers] of Object.entries(value.peers)) check([member, ...(peers ?? [])], ['peers', member]);
  value.rooms.forEach((room, index) => {
    check(room.members, ['rooms', index, 'members']);
    const selected = room.responder.kind === 'member' ? room.responder.botId : room.responder.kind === 'auto' ? room.responder.fallbackBotId : undefined;
    if (selected && !room.members.includes(selected)) ctx.addIssue({ code: 'custom', path: ['rooms', index, 'responder'], message: 'The responder must belong to this chat' });
  });
});
const botSchema = z.object({ id, revision: z.number().int().positive(), template: botTemplateSchema }).strict();
const teamSchema = z.object({ id, revision: z.number().int().positive(), definition: teamTemplateSchema }).strict();
const deploymentSchema = z.object({ id, templateId: id, kind: z.enum(['bot', 'team']), botIds: z.array(id), groupIds: z.array(id), section: z.string().optional(), members: z.record(id, id).optional() }).strict();
const fileSchema = z.object({ version: z.literal(1), bots: z.array(botSchema), teams: z.array(teamSchema), deployments: z.array(deploymentSchema) }).strict();
type RosterFile = z.infer<typeof fileSchema>;
const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });

export class Roster {
  private readonly path: string;
  constructor(path: string) { this.path = path; }
  read(): RosterFile {
    if (!existsSync(this.path)) return { version: 1, bots: [], teams: [], deployments: [] };
    try { return fileSchema.parse(JSON.parse(readFileSync(this.path, 'utf8'))); }
    catch { throw failure('The saved roster could not be read. Restore its file before making changes.', 500); }
  }
  private write(data: RosterFile) {
    const checked = fileSchema.parse(data);
    for (const team of checked.teams) this.checkMembers(checked, team.definition);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.path, JSON.stringify(checked, null, 2), { mode: 0o600 });
  }
  private checkMembers(data: RosterFile, team: TeamTemplateDefinition) {
    if (team.members.some(id => !data.bots.some(bot => bot.id === id))) throw failure('A selected bot template no longer exists. Refresh the roster and edit the team.');
  }
  saveBot(template: BotTemplate, entryId?: string, revision?: number, sourceBotId?: string) {
    const data = this.read(), current = data.bots.find(bot => bot.id === entryId);
    if (entryId && !current) throw failure('Bot template no longer exists', 404);
    if (current && current.revision !== revision) throw failure('This template changed. Reload it before saving.', 409);
    const entry = { id: current?.id ?? randomUUID(), revision: (current?.revision ?? 0) + 1, template: botTemplateSchema.parse(template) };
    data.bots = [...data.bots.filter(bot => bot.id !== entry.id), entry];
    if (sourceBotId) data.deployments.push({ id: randomUUID(), templateId: entry.id, kind: 'bot', botIds: [sourceBotId], groupIds: [] });
    this.write(data); return entry;
  }
  saveTeam(definition: TeamTemplateDefinition, entryId?: string, revision?: number) {
    const data = this.read(), current = data.teams.find(team => team.id === entryId);
    if (entryId && !current) throw failure('Team template no longer exists', 404);
    if (current && current.revision !== revision) throw failure('This template changed. Reload it before saving.', 409);
    const entry = { id: current?.id ?? randomUUID(), revision: (current?.revision ?? 0) + 1, definition: teamTemplateSchema.parse(definition) };
    data.teams = [...data.teams.filter(team => team.id !== entry.id), entry]; this.write(data); return entry;
  }
  captureTeam(templates: BotTemplate[], makeTeam: (ids: string[]) => TeamTemplateDefinition, source?: { botIds: string[]; groupIds: string[]; section: string }) {
    const data = this.read();
    const bots = templates.map(template => ({ id: randomUUID(), revision: 1, template: botTemplateSchema.parse(template) }));
    const team = { id: randomUUID(), revision: 1, definition: teamTemplateSchema.parse(makeTeam(bots.map(bot => bot.id))) };
    data.bots.push(...bots); data.teams.push(team);
    if (source) data.deployments.push({ id: randomUUID(), templateId: team.id, kind: 'team', ...source, members: Object.fromEntries(bots.map((bot, index) => [bot.id, source.botIds[index]])) });
    this.write(data); return team;
  }
  remove(kind: 'bot' | 'team', entryId: string, revision: number) {
    const data = this.read(), entries = kind === 'bot' ? data.bots : data.teams;
    const current = entries.find(entry => entry.id === entryId);
    if (!current) throw failure('Template no longer exists', 404);
    if (current.revision !== revision) throw failure('This template changed. Reload it before deleting.', 409);
    const blockers = kind === 'bot' ? data.teams.filter(team => team.definition.members.includes(entryId)) : [];
    if (blockers.length) throw Object.assign(failure(`Used by team templates: ${blockers.map(team => team.definition.name).join(', ')}. Edit those teams before deleting this bot template.`, 409), { blockers: blockers.map(team => ({ id: team.id, name: team.definition.name })) });
    if (kind === 'bot') data.bots = data.bots.filter(entry => entry.id !== entryId);
    else data.teams = data.teams.filter(entry => entry.id !== entryId);
    this.write(data);
  }
  recordDeployments(entries: RosterDeployment[]) { const data = this.read(); data.deployments.push(...entries); this.write(data); }
  botYaml(entryId: string) { const bot = this.read().bots.find(bot => bot.id === entryId); if (!bot) throw failure('Bot template no longer exists', 404); return stringify(bot.template); }
}
