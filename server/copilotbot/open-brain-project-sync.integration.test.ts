import { installBrainFixture } from '../testing/install-brain-fixture.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { launchVerificationServer } from '../../scripts/control-omb.ts';
import type { BotRecord, Store } from '../store.ts';
import { OpenBrainIntegration } from './open-brain.ts';
import { WorkspaceProjects } from './workspace-projects.ts';
import { sectionMemoryKey } from '../section-context.ts';

const url = process.env.OPEN_BRAIN_TEST_URL;
async function brain(path: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await fetch(url + '/api/v1' + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json();
}

it.skipIf(!url)('mirrors project membership and names automatically while preserving bot and team thread identities and contents', async () => {
  const fixture = await launchVerificationServer({ ...process.env, OMB_OPEN_BRAIN_URL: url });
  const api = async (path: string, method = 'GET', body?: unknown): Promise<any> => {
    const response = await fetch(fixture.info.url + path, { method, headers: { 'Content-Type': 'application/json', origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.ok, await response.clone().text()).toBe(true);
    return response.json();
  };
  const link = async (threadId: string): Promise<any> => (await api(`/api/copilotbot/open-brain?threadId=${threadId}`)).link;
  const belongs = async (threads: string[], projectId: string | null) => {
    await expect.poll(async () => Promise.all(threads.map(async thread => (await link(thread))?.projectId))).toEqual(threads.map(() => projectId));
  };
  try {
    await installBrainFixture(fixture.info.url, url!);
    const solo = (await api('/api/bots', 'POST', { name: 'Solo' })).bot;
    const member = (await api('/api/bots', 'POST', { name: 'Builder', section: 'Delivery' })).bot;
    const room = (await api('/api/groups', 'POST', { name: 'Review', memberIds: [member.id], section: 'Delivery' })).group;
    const sibling = (await api(`/api/bots/${solo.id}/tasks`, 'POST', { title: 'Second work stream' })).task;
    const teamSibling = (await api(`/api/groups/${room.id}/tasks`, 'POST', { title: 'Second team stream' })).task;
    const threads = [solo.threadId, sibling.threadId, member.threadId, room.threadId, teamSibling.threadId];
    const catalog = await api('/api/copilotbot/projects');
    const team = catalog.teams.find((item: any) => item.name === 'Delivery');
    const unrelated = (await brain('/projects', 'POST', { name: 'Launch', description: 'Unrelated workspace' })).project;
    const project = (await api('/api/copilotbot/projects', 'POST', { name: 'Launch', teamIds: [], botIds: [] })).projects[0];
    const matchesProject = (item: any) => item.description?.endsWith(`/ workspace:${project.id}`);
    await expect.poll(async () => (await brain('/projects')).projects.some(matchesProject)).toBe(true);
    const mirror = (await brain('/projects')).projects.find(matchesProject);
    expect(mirror.id).not.toBe(unrelated.id);
    await belongs(threads, null);
    const identities = await Promise.all(threads.map(async thread => (await link(thread)).id));
    const notes = await Promise.all(identities.map((session_id, index) => brain('/content', 'POST', { type: 'note', title: `Evidence ${index}`, content: 'Keep this work', session_id, tags: ['kind:decision', 'bot:builder'] })));
    const artifact = await brain('/content', 'POST', { type: 'document', title: 'Design artifact', content: 'Preserve the design', session_id: identities[0] });
    const todo = await brain('/todos', 'POST', { content: 'Keep the task', session_id: identities[3] });
    let current = (await api(`/api/copilotbot/projects/${project.id}`, 'PUT', { name: 'Launch', revision: project.revision, botIds: [solo.id], teamIds: [team.id] })).projects.find((item: any) => item.id === project.id);
    await belongs(threads, mirror.id);
    expect(await Promise.all(threads.map(async thread => (await link(thread)).id))).toEqual(identities);
    for (const note of notes) expect((await brain(`/content/${note.id}`)).item.project_ids).toEqual([mirror.id]);
    expect((await brain(`/content/${artifact.id}`)).item.project_ids).toEqual([mirror.id]);
    expect((await brain(`/todos/${todo.todo.id}`)).todo.project_id).toBe(mirror.id);
    const next = (await api('/api/copilotbot/projects', 'POST', { name: 'Delivery project', teamIds: [team.id], botIds: [] })).projects.find((item: any) => item.name === 'Delivery project');
    await expect.poll(async () => (await brain('/projects')).projects.some((item: any) => item.name === next.name)).toBe(true);
    const secondMirror = (await brain('/projects')).projects.find((item: any) => item.name === next.name);
    await belongs(threads.slice(2), secondMirror.id);
    await belongs(threads.slice(0, 2), mirror.id);
    await api('/api/sidebar-sections?section=Delivery', 'PATCH', { name: 'Engineering' });
    await api(`/api/bots/${solo.id}`, 'PATCH', { name: 'Independent' });
    await api(`/api/bots/${solo.id}/tasks/${sibling.threadId}`, 'PATCH', { title: 'Renamed work stream' });
    await expect.poll(async () => (await brain(`/sessions/${identities[1]}`)).session.name).toBe('Independent · Renamed work stream');
    current = (await api('/api/copilotbot/projects')).projects.find((item: any) => item.id === project.id);
    await api(`/api/copilotbot/projects/${project.id}`, 'PUT', { name: 'Release', revision: current.revision, botIds: [solo.id], teamIds: [] });
    await expect.poll(async () => (await brain(`/projects/${mirror.id}`)).project.name).toBe('Release');
    expect((await brain(`/projects/${unrelated.id}`)).project.name).toBe('Launch');
    await api(`/api/copilotbot/projects/${next.id}`, 'DELETE', { revision: next.revision });
    await belongs(threads.slice(2), null);
    await expect.poll(async () => (await brain(`/projects/${secondMirror.id}`)).project.status).toBe('archived');
    expect(await Promise.all(threads.map(async thread => (await link(thread)).id))).toEqual(identities);
    expect((await brain(`/todos/${todo.todo.id}`)).todo.project_id).toBe(null);
    expect((await brain(`/content/${notes[3].id}`)).item.tags).toEqual(['kind:decision', 'bot:builder']);
    expect((await brain(`/sessions/${identities[3]}/timeline`)).events.length).toBeGreaterThan(0);
    const owned = (await brain('/sessions')).sessions.filter((item: any) => identities.includes(item.id));
    expect(owned).toHaveLength(threads.length);
  } finally { await fixture.close(); }
}, 60_000);

it.skipIf(!url)('reconciles legacy links and recovers project moves whose response was lost without duplicating sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'brain-structure-'));
  const bot = { id: randomUUID(), name: 'Legacy bot', threadId: randomUUID() } as BotRecord;
  const store = { bots: [bot], groups: [], bot: () => bot, tasks: () => [{ threadId: bot.threadId, title: 'Existing work' }], groupByThread: () => undefined, taskByThread: () => ({ title: 'Existing work' }) } as unknown as Store;
  const directory = join(root, 'brain');
  const projects = new WorkspaceProjects(join(root, 'copilotbot', 'projects.json'));
  let loseReply = false;
  const request = async (path: string, options?: RequestInit) => {
    const response = await fetch(url + path, options);
    if (loseReply && options?.method === 'PUT' && path.startsWith('/api/v1/sessions/')) { loseReply = false; throw new Error('Lost response after successful move'); }
    return response;
  };
  const original = new OpenBrainIntegration(directory, store, request);
  const state = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
  const scope = `bot:${bot.id}`;
  const legacyProject = (await brain('/projects', 'POST', { name: 'Legacy bot', description: `CopilotBot ${state.installation} / ${scope}` })).project;
  const legacySession = (await brain('/sessions', 'POST', { name: 'Existing work', project_id: legacyProject.id, session_key: `copilotbot:${state.installation}:${bot.threadId}` })).session;
  const note = await brain('/content', 'POST', { type: 'note', title: 'Original note', content: 'Original body', session_id: legacySession.id });
  const manual = await brain('/content', 'POST', { type: 'note', title: 'Manually filed note', content: 'Keep separate work visible', project_ids: [legacyProject.id] });
  state.links[bot.threadId] = { id: legacySession.id, projectId: legacyProject.id, scope };
  state.projects[scope] = legacyProject.id;
  writeFileSync(join(directory, 'state.json'), JSON.stringify(state));
  const adopted = new OpenBrainIntegration(directory, store, request);
  await adopted.sync();
  expect(adopted.link(bot.threadId)).toMatchObject({ id: legacySession.id, projectId: null });
  expect((await brain(`/content/${note.id}`)).item.project_ids).toEqual([]);
  expect((await brain(`/content/${manual.id}`)).item.project_ids).toEqual([legacyProject.id]);
  expect((await brain(`/projects/${legacyProject.id}`)).project.status).toBe('active');
  projects.save({ name: 'Recovered project', botIds: [bot.id] });
  loseReply = true;
  await adopted.sync();
  expect(adopted.status().error).toContain('Lost response');
  const restored = new OpenBrainIntegration(directory, store, request);
  await restored.sync();
  const mirror = (await brain('/projects')).projects.find((item: any) => item.name === 'Recovered project');
  expect(restored.link(bot.threadId)).toMatchObject({ id: legacySession.id, projectId: mirror.id });
  expect((await brain('/sessions')).sessions.filter((item: any) => item.session_key === legacySession.session_key)).toHaveLength(1);
  expect((await brain(`/content/${note.id}`)).item.project_ids).toEqual([mirror.id]);
  expect(original.status().sessions).toBe(0);
});

it.skipIf(!url)('keeps private recall separate within a shared project and registers empty group threads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'brain-project-privacy-'));
  const alice = { id: randomUUID(), name: 'Alice', threadId: randomUUID() } as BotRecord;
  const bob = { id: randomUUID(), name: 'Bob', threadId: randomUUID() } as BotRecord;
  const sibling = randomUUID();
  const empty = { id: randomUUID(), name: 'Empty room', threadId: randomUUID(), memberIds: [] as string[] };
  const teamA = { id: randomUUID(), name: 'Team A room', threadId: randomUUID(), memberIds: [alice.id], section: 'Sync team A' };
  const teamB = { id: randomUUID(), name: 'Team B room', threadId: randomUUID(), memberIds: [bob.id], section: 'Sync team B' };
  const groups = [empty, teamA, teamB];
  const store = { bots: [alice, bob], groups, bot: (id: string) => [alice, bob].find(bot => bot.id === id), tasks: (id: string) => [{ threadId: id === alice.id ? alice.threadId : bob.threadId, title: 'First' }, ...(id === alice.id ? [{ threadId: sibling, title: 'Second' }] : [])], groupTasks: (id: string) => [{ threadId: groups.find(group => group.id === id)!.threadId, title: 'Room thread' }], groupByThread: (id: string) => groups.find(group => group.threadId === id), taskByThread: () => ({ title: 'Work' }) } as unknown as Store;
  const projects = new WorkspaceProjects(join(root, 'copilotbot', 'projects.json'));
  projects.save({ name: 'Shared organization', botIds: [alice.id, bob.id], teamIds: [sectionMemoryKey(teamA.section), sectionMemoryKey(teamB.section)] });
  const integration = new OpenBrainIntegration(join(root, 'brain'), store, (path, options) => fetch(url + path, options));
  await integration.sync();
  expect(integration.link(empty.threadId)).toMatchObject({ projectId: null, scope: `team:${empty.id}` });
  expect(integration.link(alice.threadId)?.projectId).toBe(integration.link(bob.threadId)?.projectId);
  const first: any = await integration.record(alice, alice.threadId, { title: 'Alice first', text: 'Private evidence', kind: 'note' });
  const second: any = await integration.record(alice, sibling, { title: 'Alice second', text: 'Related private evidence', kind: 'note' });
  const foreign: any = await integration.record(bob, bob.threadId, { title: 'Bob private', text: 'Unrelated private evidence', kind: 'note' });
  const teamNote: any = await integration.record(alice, teamA.threadId, { title: 'Team A note', text: 'Team A evidence', kind: 'note' });
  await integration.record(bob, teamB.threadId, { title: 'Team B note', text: 'Team B evidence', kind: 'note' });
  const ids = (value: any) => [...new Set(value.hits.map((hit: any) => hit.type === 'chunk' ? hit.chunk.content_item_id : hit.todo.id))].sort();
  await expect.poll(async () => ids(await integration.recall(alice, alice.threadId, '', 'project'))).toEqual([first.result.id, second.result.id].sort());
  expect(ids(await integration.recall(alice, alice.threadId, '', 'project'))).not.toContain(foreign.result.id);
  expect(ids(await integration.recall(alice, alice.threadId, '', 'session'))).toEqual([first.result.id]);
  await expect.poll(async () => ids(await integration.recall(alice, teamA.threadId, '', 'project'))).toEqual([teamNote.result.id]);
});

it.skipIf(!url)('adopts a successfully created session after losing the create response', async () => {
  const root = mkdtempSync(join(tmpdir(), 'brain-create-retry-'));
  const bot = { id: randomUUID(), name: 'Retry bot', threadId: randomUUID() } as BotRecord;
  const store = { bots: [bot], groups: [], bot: () => bot, tasks: () => [{ threadId: bot.threadId, title: 'Retry work' }], groupByThread: () => undefined, taskByThread: () => ({ title: 'Retry work' }) } as unknown as Store;
  let loseReply = true;
  const request = async (path: string, options?: RequestInit) => {
    const response = await fetch(url + path, options);
    if (loseReply && path === '/api/v1/sessions' && options?.method === 'POST') { loseReply = false; throw new Error('Lost create response'); }
    return response;
  };
  const directory = join(root, 'brain');
  const first = new OpenBrainIntegration(directory, store, request);
  await first.sync();
  expect(first.status().error).toContain('Lost create response');
  const state = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
  const key = `copilotbot:${state.installation}:${bot.threadId}`;
  const created = (await brain('/sessions')).sessions.find((session: any) => session.session_key === key);
  const retry = new OpenBrainIntegration(directory, store, request);
  await retry.sync();
  expect(retry.link(bot.threadId)?.id).toBe(created.id);
  expect((await brain('/sessions')).sessions.filter((session: any) => session.session_key === key)).toHaveLength(1);
});
