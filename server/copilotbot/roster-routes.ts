import { join } from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import { DATA_DIR } from '../config.ts';
import { takeImportName } from '../../shared/import-name.ts';
import type { RosterDeployment, RosterSummary } from '../../shared/roster.ts';
import { validateBotCwd } from '../bot-cwd.ts';
import type { GroupDefaultResponder } from '../../shared/wire.ts';
import type { Store, BotRecord } from '../store.ts';
import { readSectionContext, writeSectionContext } from '../section-context.ts';
import { resolveBotSkills, syncSkillLinks } from '../skills.ts';
import { createBotFromBody, type BotCreateRouteDeps } from '../routes/bots-create.ts';
import { PASS, type RouteHandler } from '../routes/table.ts';
import { exportBotTemplate, parseBotTemplate } from './bot-templates.ts';
import { Roster, teamTemplateSchema } from './roster.ts';
import type { ResourcePolicies } from './resource-access.ts';
import { storeTemplateAvatar } from './template-avatar.ts';
import { BOT_TEMPLATE_HTTP_MAX_BYTES } from '../../shared/template-avatar.ts';
import type { RosterAvatar } from '../../shared/roster.ts';

const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });
const selectionSchema = z.object({ kind: z.enum(['bot', 'team']), id: z.string().uuid() }).strict();
export function rosterRoutes(deps: { store: Store; policies: ResourcePolicies; creation: BotCreateRouteDeps }): RouteHandler {
  const { store, policies, creation } = deps;
  const roster = new Roster(join(DATA_DIR, 'copilotbot', 'roster.json'));
  let deploying = false;
  const captureBot = (bot: BotRecord, standalone = true) => parseBotTemplate(exportBotTemplate(bot,
    standalone ? policies.effective(bot) : { skills: bot.skillAccess ?? null, mcpServers: bot.mcpServers ?? null },
    creation.routines()?.listRoutines().filter(routine => routine.botId === bot.id) ?? [],
    resolveBotSkills(bot.id, bot.assignedSkills).filter(skill => skill.enabled).map(skill => skill.name))).template;
  const summaries = (): RosterSummary[] => {
    const data = roster.read();
    const active = (id: string) => { const bot = store.bot(id); return bot && !bot.hidden; };
    const count = (id: string) => data.deployments.filter(item => item.templateId === id ? item.botIds.some(active) : item.members?.[id] && active(item.members[id])).length;
    const avatar = (bot: typeof data.bots[number]): RosterAvatar => ({
      ...Object.fromEntries(['color', 'mascotBody', 'mascotExpression', 'avatarCrop', 'avatarZoom', 'avatarFocusX', 'avatarFocusY'].filter(key => Object.hasOwn(bot.template.profile, key)).map(key => [key, bot.template.profile[key as keyof typeof bot.template.profile]])),
      name: bot.template.profile.name, title: bot.template.profile.title, description: bot.template.profile.description, color: bot.template.profile.color ?? 'green',
      ...(bot.template.avatar ? { avatarUrl: storeTemplateAvatar(bot.template.avatar) } : {}),
    });
    return [
      ...data.bots.map(bot => ({ id: bot.id, kind: 'bot' as const, name: bot.template.profile.name, description: bot.template.profile.description ?? bot.template.profile.title ?? '', revision: bot.revision, memberCount: 1, usedBy: data.teams.filter(team => team.definition.members.includes(bot.id)).map(team => ({ id: team.id, name: team.definition.name })), activeCopies: count(bot.id), avatars: [avatar(bot)] })),
      ...data.teams.map(team => ({ id: team.id, kind: 'team' as const, name: team.definition.name, description: team.definition.description, revision: team.revision, memberCount: team.definition.members.length, usedBy: [], activeCopies: count(team.id), avatars: team.definition.members.flatMap(id => { const bot = data.bots.find(bot => bot.id === id); return bot ? [avatar(bot)] : []; }) })),
    ];
  };
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!path.startsWith('/api/copilotbot/roster')) return PASS;
    if (!auth.scopes.includes('admin')) return json(res, 403, { error: 'Managing the saved roster requires admin access.' });
    try {
      if (path === '/api/copilotbot/roster' && method === 'GET') return json(res, 200, { entries: summaries() });
      if (path === '/api/copilotbot/roster/bots' && method === 'POST') {
        const body = z.union([z.object({ botId: z.string().uuid() }).strict(), z.object({ yaml: z.string() }).strict()]).parse(await readBody(req, BOT_TEMPLATE_HTTP_MAX_BYTES));
        const source = 'botId' in body ? store.bot(body.botId) : undefined;
        if ('botId' in body && !source) throw failure('Bot no longer exists', 404);
        const saved = roster.saveBot(source ? captureBot(source) : parseBotTemplate((body as { yaml: string }).yaml).template, undefined, undefined, source?.id);
        return json(res, 201, { id: saved.id });
      }
      if (path === '/api/copilotbot/roster/teams' && method === 'POST') {
        const body = z.union([z.object({ section: z.string() }).strict(), z.object({ definition: teamTemplateSchema }).strict()]).parse(await readBody(req));
        if ('definition' in body) return json(res, 201, { id: roster.saveTeam(body.definition).id });
        const members = store.bots.filter(bot => !bot.hidden && (bot.section ?? '') === body.section);
        if (!members.length) throw failure('This team has no deployed bots to save. Add a bot first.');
        const warnings: string[] = [];
        const sourceGroups = store.groups.filter(group => !group.dm && (group.section ?? '') === body.section && group.memberIds.every(id => members.some(bot => bot.id === id)));
        const saved = roster.captureTeam(members.map(bot => captureBot(bot, false)), ids => {
          const mapping = new Map(members.map((bot, index) => [bot.id, ids[index]]));
          const remap = (id: string) => mapping.get(id)!;
          const rooms = store.groups.filter(group => !group.dm && (group.section ?? '') === body.section).flatMap(group => {
            if (group.memberIds.some(id => !mapping.has(id))) { warnings.push(`Chat “${group.name}” was not saved because it includes bots outside this team.`); return []; }
            const responder = group.defaultResponder;
            return [{ name: group.name, members: group.memberIds.map(remap), bulletin: group.bulletin,
              responder: responder.kind === 'member' ? { ...responder, botId: remap(responder.botId) } : responder.kind === 'auto' && responder.fallbackBotId ? { ...responder, fallbackBotId: remap(responder.fallbackBotId) } : responder,
              ...(group.cwd ? { cwd: group.cwd } : {}),
            }];
          });
          return { name: body.section || 'General', description: '', members: ids, resources: policies.team(body.section), instructions: readSectionContext(body.section)?.text ?? '',
            peers: Object.fromEntries(members.map(bot => [remap(bot.id), bot.peers ? bot.peers.filter(id => mapping.has(id)).map(remap) : null])), rooms };
        }, { botIds: members.map(bot => bot.id), groupIds: sourceGroups.map(group => group.id), section: body.section });
        return json(res, 201, { id: saved.id, warnings });
      }
      const match = path.match(/^\/api\/copilotbot\/roster\/(bots|teams)\/([\w-]+)$/);
      if (match) {
        const kind = match[1] === 'bots' ? 'bot' : 'team', id = match[2];
        if (method === 'GET') {
          const summary = summaries().find(entry => entry.id === id && entry.kind === kind);
          if (!summary) throw failure('Template no longer exists', 404);
          return json(res, 200, { ...summary, ...(kind === 'bot' ? { yaml: roster.botYaml(id) } : { definition: roster.read().teams.find(team => team.id === id)!.definition }) });
        }
        if (method === 'PUT') {
          if (kind === 'bot') {
            const body = z.object({ revision: z.number().int().positive(), yaml: z.string() }).strict().parse(await readBody(req, BOT_TEMPLATE_HTTP_MAX_BYTES));
            roster.saveBot(parseBotTemplate(body.yaml).template, id, body.revision);
          } else {
            const body = z.object({ revision: z.number().int().positive(), definition: teamTemplateSchema }).strict().parse(await readBody(req));
            roster.saveTeam(body.definition, id, body.revision);
          }
          return json(res, 200, { ok: true });
        }
        if (method === 'DELETE') {
          const body = z.object({ revision: z.number().int().positive() }).strict().parse(await readBody(req));
          roster.remove(kind, id, body.revision); return json(res, 200, { ok: true });
        }
      }
      if (path === '/api/copilotbot/roster/deploy' && method === 'POST') {
        const body = z.object({ requestId: z.string().uuid(), selections: z.array(selectionSchema).min(1) }).strict().parse(await readBody(req));
        const existing = roster.read().deployments.filter(item => item.id === body.requestId);
        if (existing.length) return json(res, 200, { deployments: existing, replayed: true });
        if (deploying) throw failure('Another roster deployment is in progress. Try again when it finishes.', 409);
        if (new Set(body.selections.map(item => item.id)).size !== body.selections.length) throw failure('Choose each template only once');
        deploying = true;
        const created: string[] = [], groups: string[] = [], sections: string[] = [];
        try {
          const data = roster.read();
          const takenBots = new Set(store.bots.map(bot => bot.name.toLowerCase())), takenTeams = new Set(store.sections.map(name => name.toLowerCase()));
          const plans = body.selections.map(selection => {
            const team = selection.kind === 'team' ? data.teams.find(team => team.id === selection.id) : undefined;
            const ids = team?.definition.members ?? [selection.id];
            if (selection.kind === 'team' && !team) throw failure('Team template no longer exists', 404);
            for (const room of team?.definition.rooms ?? []) {
              const checked = validateBotCwd(room.cwd ?? null);
              if (!checked.ok) throw failure(`Chat “${room.name}”: ${checked.error}`);
            }
            const section = team ? takeImportName(team.definition.name, takenTeams, 60) : '';
            const bots = ids.map(id => {
              const saved = data.bots.find(bot => bot.id === id);
              if (!saved) throw failure('A bot template no longer exists. Refresh the roster.', 409);
              const defaults = parseBotTemplate(stringify(saved.template)).defaults;
              defaults.profile = { ...defaults.profile, name: takeImportName(saved.template.profile.name, takenBots), section, approvalMode: 'ask', alwaysAllow: [], chiefOfStaff: false, managedSections: [] };
              defaults.routines = defaults.routines.map(routine => ({ ...routine, enabled: false }));
              return { saved, defaults };
            });
            return { selection, team, bots, section };
          });
          const count = plans.reduce((total, plan) => total + plan.bots.length, 0);
          if (store.bots.length + count > creation.maxWorkspaceBots) throw failure(`This deployment exceeds the workspace limit of ${creation.maxWorkspaceBots} bots.`, 409);
          const request = (defaults: typeof plans[number]['bots'][number]['defaults']) => ({ template: defaults, useDefaults: false, requireAvailableModel: Boolean(defaults.profile.modelSelection), ...(defaults.profile.modelSelection ? { modelSelection: defaults.profile.modelSelection } : {}) });
          for (const plan of plans) for (const bot of plan.bots) {
            const checked = await createBotFromBody(creation, request(bot.defaults), auth, true);
            if (checked.status !== 200) throw failure(checked.body.error ?? 'Template cannot be deployed', checked.status);
          }
          const deployments: RosterDeployment[] = [];
          const warnings: string[] = [];
          for (const plan of plans) {
            if (plan.team) sections.push(plan.section);
            const mapping = new Map<string, string>();
            for (const entry of plan.bots) {
              const result = await createBotFromBody(creation, request(entry.defaults), auth);
              if (!result.body.bot) throw failure(result.body.error ?? 'Bot could not be deployed', result.status);
              created.push(result.body.bot.id); mapping.set(entry.saved.id, result.body.bot.id);
              warnings.push(...(result.body.warnings ?? []).map(warning => `${result.body.bot!.name}: ${warning}`));
            }
            const groupIds: string[] = [];
            if (plan.team) {
              const definition = plan.team.definition;
              policies.setTeam(plan.section, definition.resources);
              writeSectionContext(plan.section, definition.instructions);
              for (const [templateId, botId] of mapping) {
                const peers = definition.peers[templateId];
                store.patchBot(botId, { peers: peers == null ? undefined : peers.map(id => mapping.get(id)!) });
                syncSkillLinks(botId);
              }
              const chief = plan.bots.find(entry => entry.saved.template.profile.chiefOfStaff);
              if (chief) store.setChiefOfStaff(mapping.get(chief.saved.id)!);
              for (const room of definition.rooms) {
                const responder: GroupDefaultResponder = room.responder.kind === 'member' ? { kind: 'member', botId: mapping.get(room.responder.botId)! }
                  : room.responder.kind === 'auto' && room.responder.fallbackBotId ? { kind: 'auto', fallbackBotId: mapping.get(room.responder.fallbackBotId)! } : room.responder;
                const group = store.createGroup(room.name, room.members.map(id => mapping.get(id)!), false, plan.section, { bulletin: room.bulletin, defaultResponder: responder, completed: true });
                groups.push(group.id); groupIds.push(group.id);
                if (room.cwd) store.patchGroup(group.id, { cwd: room.cwd });
              }
            }
            deployments.push({ id: body.requestId, templateId: plan.selection.id, kind: plan.selection.kind, botIds: [...mapping.values()], groupIds, ...(plan.section ? { section: plan.section, members: Object.fromEntries(mapping) } : {}) });
          }
          roster.recordDeployments(deployments);
          return json(res, 201, { deployments, warnings });
        } catch (error) {
          for (const id of groups) store.deleteGroup(id);
          for (const id of created) { for (const routine of creation.routines()?.listRoutines().filter(routine => routine.botId === id) ?? []) creation.routines()?.remove(routine.id); store.deleteBot(id); }
          for (const section of sections) { policies.removeTeam(section); store.deleteSection(section); }
          throw error;
        } finally { deploying = false; }
      }
      return PASS;
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 400;
      return json(res, status, { error: error instanceof Error ? error.message : String(error), ...(error && typeof error === 'object' && 'blockers' in error ? { blockers: error.blockers } : {}) });
    }
  };
}
