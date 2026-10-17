import { z } from 'zod';
import { PASS, type RouteHandler } from '../routes/table.ts';
import { customMcpServers, type AppConfig } from '../config.ts';
import type { Store, BotRecord } from '../store.ts';
import { listSkills, resolveBotSkills, syncSkillLinks } from '../skills.ts';
import { availableLibrarySkills } from '../skill-library.ts';
import { resourceAccessSchema, unrestricted, type ResourceAccess, type ResourcePolicies } from './resource-access.ts';
import { exportBotTemplate, parseBotTemplate, previewBotTemplates, type BotTemplate } from './bot-templates.ts';
import { allMcpServers } from '../plugins/contributions.ts';

function widens(previous: ResourceAccess, next: ResourceAccess): boolean {
  return (['skills', 'mcpServers'] as const).some(key => previous[key] !== null && (next[key] === null || next[key].some(name => !previous[key]!.includes(name))));
}

export function resourceRoutes(deps: {
  store: Store; cfg: AppConfig; policies: ResourcePolicies;
  busy(bot: BotRecord): boolean;
  routines(botId: string): unknown[];
  sessionLive(id: string): boolean;
}): RouteHandler {
  const { store, cfg, policies } = deps;
  const catalog = (bots: BotRecord[]) => {
    const skills = new Map<string, { name: string; enabled: boolean; description: string; origin: "private" | "library" }>();
    for (const skill of availableLibrarySkills(cfg)) skills.set(skill.name, { ...skill, origin: "library" });
    for (const bot of bots) for (const skill of listSkills(bot.id)) skills.set(skill.name, { ...skill, origin: "private" });
    return {
      skills: [...skills.values()].map(({ name, enabled, description, origin }) => ({ name, enabled, description, origin })),
      mcpServers: Object.keys(allMcpServers(cfg.mcpServers)).map(name => ({ name, enabled: name in customMcpServers(cfg) })),
    };
  };
  const warnings = (template: BotTemplate) => {
    const available = catalog([]);
    return [
      ...[...new Set([...template.skills, ...(template.resources.skills ?? [])])].filter(name => !available.skills.some(skill => skill.name === name && skill.enabled && skill.origin === "library")).map(name => `Skill “${name}” is missing or disabled. Install and review it before use.`),
      ...(template.resources.mcpServers ?? []).filter(name => !available.mcpServers.some(server => server.name === name && server.enabled)).map(name => `MCP server “${name}” is missing or disabled. Configure it before use.`),
    ];
  };
  return async ({ req, res, path, method, url, auth, json, readBody }) => {
    if (!path.startsWith('/api/copilotbot/')) return PASS;
    if (!['/api/copilotbot/bot-template', '/api/copilotbot/bot-templates', '/api/copilotbot/resources'].includes(path) && !/^\/api\/copilotbot\/bots\/[\w-]+\/(?:template|resources)$/.test(path)) return PASS;
    if (!auth.scopes.includes('admin')) return json(res, 403, { error: 'Managing templates and resources requires admin access.' });
    try {
      if (path === '/api/copilotbot/bot-template' && method === 'POST') {
        const body = z.object({ yaml: z.string() }).strict().parse(await readBody(req));
        const parsed = parseBotTemplate(body.yaml);
        return json(res, 200, { defaults: parsed.defaults, warnings: warnings(parsed.template) });
      }
      if (path === '/api/copilotbot/bot-templates' && method === 'POST') {
        const body = z.object({ files: z.array(z.object({ filename: z.string().min(1), yaml: z.string() }).strict()).min(1) }).strict().parse(await readBody(req));
        return json(res, 200, { templates: previewBotTemplates(body.files, warnings) });
      }
      const match = path.match(/^\/api\/copilotbot\/bots\/([\w-]+)\/(template|resources)$/);
      const bot = match ? store.bot(match[1]) : undefined;
      if (match && !bot) return json(res, 404, { error: 'No such bot' });
      if (bot && match?.[2] === 'template' && method === 'GET') {
        return json(res, 200, { filename: `${bot.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() || 'bot'}.bot.yaml`, yaml: exportBotTemplate(bot, policies.effective(bot), deps.routines(bot.id), resolveBotSkills(bot.id, bot.assignedSkills).filter(skill => skill.enabled).map(skill => skill.name)) });
      }
      if (match?.[2] === 'template') return PASS;
      const section = url.searchParams.get('section');
      const newTeamDraft = !bot && method === 'GET' && url.searchParams.get('draft') === '1' && section !== null && section !== '' && section.length <= 60 && !store.sections.includes(section);
      if (!bot && !newTeamDraft && (section === null || (section !== '' && !store.sections.includes(section)))) return json(res, 404, { error: 'Choose an existing team' });
      const members = bot ? [bot] : store.bots.filter(item => (item.section ?? '') === section);
      if (method === 'PUT') {
        const body = await readBody(req);
        if (auth.kind === 'session' && !deps.sessionLive(auth.session.id)) return json(res, 401, { error: 'This session has expired or was revoked.' });
        const policy = resourceAccessSchema.parse(body);
        const previous = bot ? { skills: bot.skillAccess ?? null, mcpServers: bot.mcpServers ?? null } : policies.team(section!);
        if (auth.kind === 'loopback' && !req.headers.origin && widens(previous, policy) && store.bots.some(deps.busy)) {
          return json(res, 409, { error: 'Use the app or stop all running bots before expanding resource access.' });
        }
        if (!bot && section !== '' && !store.sections.includes(section!)) return json(res, 404, { error: 'No such team' });
        if (members.some(deps.busy)) return json(res, 409, { error: 'Stop the affected bots before changing their resources.' });
        if (bot) {
          const library = new Set(availableLibrarySkills(cfg).map(skill => skill.name));
          const assignedSkills = [...new Set([...(bot.assignedSkills ?? []), ...(policy.skills ?? []).filter(name => library.has(name))])];
          store.patchBot(bot.id, { skillAccess: policy.skills ?? undefined, mcpServers: policy.mcpServers ?? undefined, assignedSkills });
        } else policies.setTeam(section!, policy);
        for (const member of members) syncSkillLinks(member.id);
      } else if (method !== 'GET') return PASS;
      const current = bot ? store.bot(bot.id)! : undefined;
      return json(res, 200, {
        policy: current ? { skills: current.skillAccess ?? null, mcpServers: current.mcpServers ?? null } : newTeamDraft ? unrestricted() : policies.team(section!),
        inherited: current ? policies.team(current.section) : unrestricted(),
        effective: current ? policies.effective(current) : newTeamDraft ? unrestricted() : policies.team(section!),
        catalog: catalog(members), busy: members.some(deps.busy),
      });
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
