import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../atomic.ts';
import { DATA_DIR } from '../config.ts';
import { sectionMemoryKey } from '../section-context.ts';
import type { Store } from '../store.ts';
import { PASS, type RouteHandler } from '../routes/table.ts';
import type { WorkspaceProject, WorkspaceProjectCatalog } from '../../shared/workspace-projects.ts';

const fields = z.object({ name: z.string().trim().min(1).max(60), collapsed: z.boolean().default(false), teamIds: z.array(z.string().min(1)).default([]), botIds: z.array(z.string().uuid()).default([]) }).strict();
const projectSchema = fields.extend({ id: z.string().uuid(), revision: z.number().int().positive() });
const fileSchema = z.object({ version: z.literal(1), projects: z.array(projectSchema) }).strict();
const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });

export class WorkspaceProjects {
  private readonly file: string;
  constructor(file: string) { this.file = file; }
  list(): WorkspaceProject[] {
    if (!existsSync(this.file)) return [];
    try { return fileSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))).projects; }
    catch { throw failure('Saved projects could not be read. Restore the projects file before editing it.', 500); }
  }
  private write(projects: WorkspaceProject[]) {
    const data = fileSchema.parse({ version: 1, projects });
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
  save(input: z.input<typeof fields>, id?: string, revision?: number): WorkspaceProject {
    const projects = this.list();
    const previous = projects.find(project => project.id === id);
    if (id && !previous) throw failure('Project no longer exists. Refresh the project list.', 404);
    if (previous && previous.revision !== revision) throw failure('This project changed. Refresh it before saving.', 409);
    const value = fields.parse(input);
    if (projects.some(project => project.id !== id && project.name.toLowerCase() === value.name.toLowerCase())) throw failure('A project with that name already exists.', 409);
    const saved = { ...value, teamIds: [...new Set(value.teamIds)], botIds: [...new Set(value.botIds)], id: id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1 };
    const movedTeams = new Set(saved.teamIds), movedBots = new Set(saved.botIds);
    const next = projects.filter(project => project.id !== id).map(project => {
      const teamIds = project.teamIds.filter(id => !movedTeams.has(id)), botIds = project.botIds.filter(id => !movedBots.has(id));
      return teamIds.length === project.teamIds.length && botIds.length === project.botIds.length ? project : { ...project, teamIds, botIds, revision: project.revision + 1 };
    });
    const index = previous ? projects.indexOf(previous) : next.length;
    next.splice(index, 0, saved); this.write(next); return saved;
  }
  collapse(id: string, collapsed: boolean, revision: number): WorkspaceProject {
    const previous = this.list().find(project => project.id === id);
    if (!previous) throw failure('Project no longer exists. Refresh the project list.', 404);
    const { name, teamIds, botIds } = previous;
    return this.save({ name, teamIds, botIds, collapsed }, id, revision);
  }
  remove(id: string, revision: number) {
    const projects = this.list(), previous = projects.find(project => project.id === id);
    if (!previous) throw failure('Project no longer exists.', 404);
    if (previous.revision !== revision) throw failure('This project changed. Refresh it before removing it.', 409);
    this.write(projects.filter(project => project.id !== id));
  }
}

export function workspaceProjectRoutes(deps: { store: Store; changed: () => void; sessionLive: (id: string) => boolean }): RouteHandler {
  const storage = new WorkspaceProjects(join(DATA_DIR, 'copilotbot', 'projects.json'));
  const catalog = (): WorkspaceProjectCatalog => ({ projects: storage.list(), teams: deps.store.sections.map(name => ({ name, id: sectionMemoryKey(name) })) });
  return async ({ path, method, req, res, auth, readBody, json }) => {
    if (!path.startsWith('/api/copilotbot/projects')) return PASS;
    if (!auth.scopes.includes('admin')) return json(res, 403, { error: 'Managing projects requires owner access.' });
    try {
      if (path === '/api/copilotbot/projects' && method === 'GET') return json(res, 200, catalog());
      const match = /^\/api\/copilotbot\/projects\/([\w-]+)$/.exec(path);
      const creating = path === '/api/copilotbot/projects' && method === 'POST';
      if (!creating && !match) return json(res, 404, { error: 'Project route not found' });
      if (!creating && !['PUT', 'PATCH', 'DELETE'].includes(method)) return json(res, 405, { error: 'Method not allowed' });
      const body = await readBody(req);
      if (auth.kind === 'session' && !deps.sessionLive(auth.session.id)) return json(res, 401, { error: 'This session has expired.' });
      if (method === 'DELETE' && match) {
        const { revision } = z.object({ revision: z.number().int().positive() }).strict().parse(body);
        storage.remove(match[1], revision);
      } else if (method === 'PATCH' && match) {
        const { revision, collapsed } = z.object({ revision: z.number().int().positive(), collapsed: z.boolean() }).strict().parse(body);
        storage.collapse(match[1], collapsed, revision);
      } else if (creating || method === 'PUT') {
        const checked = method === 'PUT' ? fields.extend({ revision: z.number().int().positive() }).parse(body) : fields.parse(body);
        const teams = new Set(catalog().teams.map(team => team.id));
        if (checked.teamIds.some(id => !teams.has(id))) throw failure('A selected team no longer exists. Refresh the project list.');
        if (checked.botIds.some(id => { const bot = deps.store.bot(id); return !bot || bot.hidden || Boolean(bot.section); })) throw failure('Choose existing bots outside teams. Bots in a team follow that team’s project.');
        const { name, collapsed, teamIds, botIds } = checked;
        storage.save({ name, collapsed, teamIds, botIds }, match?.[1], 'revision' in checked && typeof checked.revision === 'number' ? checked.revision : undefined);
      } else return json(res, 405, { error: 'Method not allowed' });
      deps.changed();
      return json(res, method === 'POST' ? 201 : 200, catalog());
    } catch (error) { return json(res, error instanceof z.ZodError ? 400 : (error as { status?: number }).status ?? 400, { error: error instanceof Error ? error.message : 'Project update failed' }); }
  };
}
