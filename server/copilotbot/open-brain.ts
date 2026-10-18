import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../atomic.ts';
import type { Store, BotRecord } from '../store.ts';
import { sectionMemoryKey } from '../section-context.ts';
import { WorkspaceProjects } from './workspace-projects.ts';
import type { WorkspaceProject } from '../../shared/workspace-projects.ts';
import { OPEN_BRAIN_GUIDANCE } from './open-brain-tools.ts';

const kinds = ['note', 'artifact', 'decision', 'discovery', 'action', 'callout'] as const;
export const brainRecordSchema = z.object({ title: z.string().trim().min(1), text: z.string().min(1), kind: z.enum(kinds), tags: z.array(z.string()).default([]), contributors: z.array(z.string()).default([]), file: z.string().optional() }).strict();
export const brainTaskSchema = z.object({ content: z.string().trim().min(1), tags: z.array(z.string()).default([]), contributors: z.array(z.string()).default([]), id: z.string().uuid().optional(), status: z.enum(['not_started','in_progress','paused','done']).optional() }).strict();
type Request = (path: string, options?: RequestInit) => Promise<Response>;
type Link = { id: string; projectId: string | null; scope: string };
type BrainProject = { id: string; name: string; description: string | null; status: string };
type BrainSession = { id: string; name: string; session_key: string; project_id: string | null };
type BrainCatalog = { projects: BrainProject[]; sessions: BrainSession[] };
type Pending = { id: string; threadId: string; botId: string; kind: 'record' | 'task'; value: Record<string, unknown>; file?: string };
type Saved = { version: 1; installation: string; links: Record<string, Link>; projects: Record<string, string>; pending: Pending[] };
const slug = (value: string) => value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bot';

export class OpenBrainIntegration {
  private readonly file: string;
  private readonly store: Store;
  private readonly request: Request;
  private readonly directory: string;
  private state: Saved;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly projects: WorkspaceProjects;
  private readonly changed: () => void;
  error?: string;
  private syncing?: Promise<void>;
  private syncAgain = false;
  constructor(directory: string, store: Store, request: Request, changed: () => void = () => {}) {
    this.directory = directory; this.file = join(directory, 'state.json'); this.store = store; this.request = request; this.changed = changed;
    this.projects = new WorkspaceProjects(join(directory, '..', 'copilotbot', 'projects.json'));
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { version: 1, installation: randomUUID(), links: {}, projects: {}, pending: [] };
    if (this.state.version !== 1 || !this.state.links || !this.state.projects || !Array.isArray(this.state.pending)) throw new Error('Open Brain integration state is invalid; restore it before continuing.');
    this.save();
  }
  private save() { mkdirSync(this.directory, { recursive: true, mode: 0o700 }); writeFileAtomic(this.file, JSON.stringify(this.state), { mode: 0o600 }); }
  private serial<T>(action: () => Promise<T>): Promise<T> { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  private async json(path: string, method = 'GET', body?: unknown): Promise<any> {
    const response = await this.request(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`Open Brain returned HTTP ${response.status}`);
    return response.json();
  }
  private scope(bot: BotRecord | undefined, threadId: string) {
    const group = this.store.groupByThread(threadId);
    if (!group && !bot) throw new Error('The conversation owner no longer exists.');
    const section = group ? group.section : bot?.section;
    const teamId = section ? sectionMemoryKey(section) : undefined;
    const project = this.projects.list().find(project => teamId ? project.teamIds.includes(teamId) : !group && bot ? project.botIds.includes(bot.id) : false);
    return { key: group ? `team:${teamId ?? group.id}` : `bot:${bot!.id}`,
      project,
      title: group ? `${group.name} · ${this.store.groupTasks(group.id).find(task => task.threadId === threadId)?.title ?? group.name}` : `${bot!.name} · ${this.store.taskByThread(bot!.id, threadId)?.title ?? 'Conversation'}` };
  }
  private async catalog(): Promise<BrainCatalog> {
    const [projects, sessions] = await Promise.all([this.json('/api/v1/projects'), this.json('/api/v1/sessions')]);
    return { projects: projects.projects, sessions: sessions.sessions };
  }
  private async ensureProject(project: WorkspaceProject, catalog: BrainCatalog): Promise<string> {
    const key = `workspace:${project.id}`;
    const marker = `CopilotBot ${this.state.installation} / ${key}`;
    let target = catalog.projects.find(item => item.id === this.state.projects[key] && item.description === marker)
      ?? catalog.projects.find(item => item.description === marker);
    if (!target) {
      target = (await this.json('/api/v1/projects', 'POST', { name: project.name, description: marker })).project as BrainProject;
      catalog.projects.push(target);
    } else if (target.name !== project.name || target.status !== 'active') {
      Object.assign(target, (await this.json(`/api/v1/projects/${target.id}`, 'PUT', { name: project.name, status: 'active' })).project);
    }
    if (this.state.projects[key] !== target.id) { this.state.projects[key] = target.id; this.save(); }
    return target.id;
  }
  private async ensure(bot: BotRecord | undefined, threadId: string, snapshot?: BrainCatalog): Promise<Link> {
    const catalog = snapshot ?? await this.catalog();
    const scope = this.scope(bot, threadId);
    const projectId = scope.project ? await this.ensureProject(scope.project, catalog) : null;
    const key = `copilotbot:${this.state.installation}:${threadId}`;
    const cached = this.state.links[threadId];
    const matches = catalog.sessions.filter(session => session.session_key === key);
    if (matches.length > 1) throw new Error('Multiple Open Brain sessions have the same CopilotBot thread key. Resolve the duplicates before syncing.');
    let session = catalog.sessions.find(session => session.id === cached?.id) ?? matches[0];
    if (session && session.session_key !== key) throw new Error('The saved Open Brain session belongs to another thread.');
    if (!session) {
      session = (await this.json('/api/v1/sessions', 'POST', { name: scope.title, project_id: projectId, session_key: key })).session as BrainSession;
      catalog.sessions.push(session);
    } else if (session.name !== scope.title || session.project_id !== projectId) {
      Object.assign(session, (await this.json(`/api/v1/sessions/${session.id}`, 'PUT', { name: scope.title, project_id: projectId })).session);
    }
    const link = { id: session.id, projectId, scope: scope.key };
    if (JSON.stringify(cached) !== JSON.stringify(link)) { this.state.links[threadId] = link; this.save(); this.changed(); }
    return link;
  }
  private async retireEmptyProjects(catalog: BrainCatalog, active: Set<string>) {
    const retired = catalog.projects.filter(project => !active.has(project.id) && project.status !== 'archived'
      && Object.values(this.state.projects).includes(project.id)
      && project.description?.startsWith(`CopilotBot ${this.state.installation} / `)
      && !catalog.sessions.some(session => session.project_id === project.id));
    if (!retired.length) return;
    const { counts } = await this.json('/api/v1/projects/counts');
    for (const project of retired) {
      const count = counts.find((item: any) => item.project_id === project.id);
      if (!count || count.documents || count.notes || count.todos) continue;
      Object.assign(project, (await this.json(`/api/v1/projects/${project.id}`, 'PUT', { status: 'archived' })).project);
    }
  }
  status() { return { configured: true, error: this.error, pending: this.state.pending.length, sessions: Object.keys(this.state.links).length }; }
  link(threadId: string) { return this.state.links[threadId]; }
  sync(): Promise<void> {
    if (this.syncing) { this.syncAgain = true; return this.syncing; }
    this.syncing = this.serial(async () => {
      try {
        do {
        this.syncAgain = false;
        const catalog = await this.catalog();
        const active = new Set<string>();
        for (const project of this.projects.list()) active.add(await this.ensureProject(project, catalog));
        for (const bot of this.store.bots) for (const task of this.store.tasks(bot.id)) await this.ensure(bot, task.threadId, catalog);
        for (const group of this.store.groups) {
          const bot = group.memberIds.map(id => this.store.bot(id)).find(Boolean) ?? undefined;
          for (const task of this.store.groupTasks(group.id).length ? this.store.groupTasks(group.id) : [{ threadId: group.threadId }]) await this.ensure(bot, task.threadId, catalog);
        }
        await this.retireEmptyProjects(catalog, active);
        const errors: string[] = [];
        for (const item of [...this.state.pending]) { try { await this.deliver(item); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); } }
        this.error = errors.join('; ') || undefined;
        } while (this.syncAgain);
      } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
      this.changed();
    }).finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
  async prepare(bot: BotRecord, threadId: string): Promise<string> {
    return this.serial(async () => {
      try {
        const link = await this.ensure(bot, threadId);
        const context = await this.json(`/api/v1/sessions/${link.id}/context`);
        this.error = undefined;
        return `\n${OPEN_BRAIN_GUIDANCE}\nAssigned session ${link.id}; project ${link.projectId ?? 'none (standalone session)'}.\nCurrent scoped evidence:\n${JSON.stringify({ session: context })}`;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error); this.changed();
        return `\n${OPEN_BRAIN_GUIDANCE}\nOpen Brain is temporarily unavailable. Still use brain_record and brain_task to queue useful notes, artifacts, decisions and tasks. Tell the user they are pending; never claim durable Open Brain storage until confirmed.`;
      }
    });
  }
  private authorTags(bot: BotRecord, threadId: string, kind: string, tags: string[], contributors: string[]) {
    const group = this.store.groupByThread(threadId);
    const allowed = new Set(group?.memberIds ?? [bot.id]);
    if (contributors.some(id => !allowed.has(id))) throw new Error('Contributors must be bots in this conversation.');
    const authors = [...new Set([bot.id, ...contributors])].map(id => this.store.bot(id)!);
    return [...new Set([`kind:${kind}`, ...authors.flatMap(author => [`bot:${slug(author.name)}`, `bot-id:${author.id}`]), ...tags.filter(tag => !/^(kind|bot|bot-id|capture):/.test(tag))])];
  }
  async record(bot: BotRecord, threadId: string, input: unknown, filePath?: string) {
    const value = brainRecordSchema.parse(input);
    const item: Pending = { id: randomUUID(), botId: bot.id, threadId, kind: 'record', value: { title: value.title, content: value.text, tags: this.authorTags(bot, threadId, value.kind, value.tags, value.contributors) } };
    if (filePath) { mkdirSync(join(this.directory, 'artifacts'), { recursive: true, mode: 0o700 }); item.file = join(this.directory, 'artifacts', `${item.id}-${basename(filePath)}`); copyFileSync(filePath, item.file); }
    return this.enqueue(item);
  }
  async task(bot: BotRecord, threadId: string, input: unknown) {
    const value = brainTaskSchema.parse(input);
    return this.enqueue({ id: randomUUID(), botId: bot.id, threadId, kind: 'task', value: { ...value, tags: this.authorTags(bot, threadId, 'task', value.tags, value.contributors), contributors: undefined } });
  }
  private async enqueue(item: Pending) {
    return this.serial(async () => {
      this.state.pending.push(item); this.save();
      try { const result = await this.deliver(item); this.error = undefined; this.changed(); return { status: 'saved', result }; }
      catch (error) { this.error = error instanceof Error ? error.message : String(error); this.changed(); return { status: 'queued', captureId: item.id, message: 'Saved locally for retry; not yet stored in Open Brain.' }; }
    });
  }
  private async deliver(item: Pending) {
    const bot = this.store.bot(item.botId); if (!bot) throw new Error('The author bot no longer exists.');
    const link = await this.ensure(bot, item.threadId), tag = `capture:${item.id}`;
    const tags = [...item.value.tags as string[], tag];
    const endpoint = item.kind === 'task' ? '/api/v1/todos' : '/api/v1/content';
    const listing = await this.json(`${endpoint}?session_id=${link.id}&tags=${encodeURIComponent(tag)}`);
    let result = (listing.items ?? listing.todos ?? []).find((value: any) => value.tags?.includes(tag));
    if (!result) {
      if (item.kind === 'task' && item.value.id) {
        const current = await this.json(`/api/v1/todos/${item.value.id}`);
        if (current.todo.session_id !== link.id) throw new Error('That task belongs to a different session.');
        const { id: _id, ...body } = item.value;
        result = await this.json(`/api/v1/todos/${item.value.id}`, 'PUT', { ...body, tags: [...new Set([...current.todo.tags, ...tags])] });
      } else if (item.file) {
        const form = new FormData(); form.set('file', new Blob([readFileSync(item.file)]), basename(item.file).slice(item.id.length + 1)); form.set('type', 'document'); form.set('deduplicate', 'false'); form.set('content', String(item.value.content)); form.set('session_id', link.id); form.set('title', String(item.value.title)); form.set('tags', tags.join(','));
        const response = await this.request(endpoint, { method: 'POST', body: form }); if (!response.ok) throw new Error(`Artifact upload returned HTTP ${response.status}`); result = await response.json();
      } else { const { id: _id, status: _status, ...body } = item.value; result = await this.json(endpoint, 'POST', { ...body, session_id: link.id, tags, ...(item.kind === 'record' ? { type: 'note' } : {}) }); }
    }
    if (item.kind === 'task' && item.value.status && !item.value.id) {
      const id = result.todo?.id ?? result.id;
      result = await this.json(`/api/v1/todos/${id}`, 'PUT', { status: item.value.status });
    }
    this.state.pending = this.state.pending.filter(pending => pending.id !== item.id); this.save(); return result;
  }
  async recall(bot: BotRecord, threadId: string, query: string, scope = 'session') {
    return this.serial(async () => {
      const link = await this.ensure(bot, threadId);
      const related = scope === 'project' && link.projectId
        ? Object.values(this.state.links).filter(candidate => candidate.scope === link.scope && candidate.projectId === link.projectId)
        : [link];
      const results = await Promise.all(related.map(candidate => this.json('/api/v1/search', 'POST', { query, session_id: candidate.id })));
      return { hits: results.flatMap(result => result.hits).sort((a, b) => (b.final_score ?? 0) - (a.final_score ?? 0)) };
    });
  }
}
