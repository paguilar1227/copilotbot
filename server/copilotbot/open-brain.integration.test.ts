import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { OpenBrainIntegration } from './open-brain.ts';
import type { Store, BotRecord } from '../store.ts';
import { launchVerificationServer } from '../../scripts/control-omb.ts';
const url = process.env.OPEN_BRAIN_TEST_URL;
it.skipIf(!url)('persists real session-owned notes, tasks and files, isolates recall, and attributes team decisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'brain-integration-'));
  const alice = { id: randomUUID(), name: 'Alice', section: 'Research' } as BotRecord;
  const bob = { id: randomUUID(), name: 'Bob', section: 'Research' } as BotRecord;
  const group = { id: randomUUID(), name: 'Review', memberIds: [alice.id, bob.id], section: 'Research' };
  const threads = [randomUUID(), randomUUID(), randomUUID()];
  const store = { bots: [alice,bob], groups: [group], bot: (id: string) => [alice,bob].find(bot => bot.id === id), tasks: (id: string) => [{ threadId: id === alice.id ? threads[0] : threads[1], title: 'Private task' }], groupTasks: () => [{ threadId: threads[2], title: 'Team review' }], groupByThread: (id: string) => id === threads[2] ? group : undefined, taskByThread: () => ({ title: 'Private task' }) } as unknown as Store;
  let online = true;
  const request = (path: string, options?: RequestInit) => { if (!online) return Promise.reject(new Error('Synthetic offline')); return fetch(url + path, options); };
  const brain = new OpenBrainIntegration(join(root,'brain'), store, request);
  await brain.sync();
  expect(brain.status()).toMatchObject({ sessions: 3 });
  const ids = threads.map(thread => brain.link(thread)!);
  expect(new Set(ids.map(link => link.id)).size).toBe(3);
  expect(new Set(ids.map(link => link.projectId)).size).toBe(3);
  await brain.prepare(alice,threads[2]); await brain.prepare(bob,threads[2]);
  expect(brain.link(threads[2])?.id).toBe(ids[2].id);
  const saved = await brain.record(alice,threads[2],{title:'Use queueing',text:'Reviewed worker evidence; queue writes.',kind:'decision',tags:['architecture'],contributors:[bob.id]});
  expect(saved.status).toBe('saved');
  const context = await fetch(`${url}/api/v1/sessions/${ids[2].id}/context`).then((r):Promise<any>=>r.json());
  expect(context.artifacts).toHaveLength(1);
  const note = await fetch(`${url}/api/v1/content/${context.artifacts[0].id}`).then((r):Promise<any>=>r.json());
  expect(note.item.tags).toEqual(expect.arrayContaining(['kind:decision','bot:alice','bot:bob',`bot-id:${alice.id}`,'architecture']));
  await expect(brain.record(alice,threads[2],{title:'Bad',text:'No',kind:'decision',contributors:[randomUUID()]})).rejects.toThrow('Contributors');
  const task = await brain.task(alice,threads[2],{content:'Validate queue',status:'in_progress'});
  expect(task.status).toBe('saved');
  const work = await fetch(`${url}/api/v1/todos?session_id=${ids[2].id}`).then((r):Promise<any>=>r.json());
  expect(work.todos[0].status).toBe('in_progress');
  expect(work.todos[0].tags).toContain('bot:alice');
  const file = join(root,'report.txt');writeFileSync(file,'Queue verification artifact.');
  expect((await brain.record(bob,threads[2],{title:'Report',text:'Evidence attached',kind:'artifact'},file)).status).toBe('saved');
  expect((await brain.record(alice,threads[2],{title:'Alice report',text:'Alice independently reviewed the same file',kind:'artifact',tags:['alice-review']},file)).status).toBe('saved');
  const uploads=await fetch(`${url}/api/v1/content?session_id=${ids[2].id}&tags=kind%3Aartifact`).then((r):Promise<any>=>r.json());
  expect(uploads.items).toHaveLength(2);
  expect(uploads.items.find((item:any)=>item.title==='Alice report').tags).toContain('bot:alice');
  expect(uploads.items.find((item:any)=>item.title==='Report').tags).toContain('bot:bob');
  online = false;
  expect((await brain.record(alice,threads[0],{title:'Offline',text:'Persistent pending note',kind:'note'})).status).toBe('queued');
  const restored = new OpenBrainIntegration(join(root,'brain'),store,request);expect(restored.status().pending).toBe(1);
  online = true;await restored.sync();expect(restored.status().pending).toBe(0);
  const privateContext=await fetch(`${url}/api/v1/sessions/${ids[0].id}/context`).then((r):Promise<any>=>r.json());expect(privateContext.artifacts).toHaveLength(1);
  const otherContext=await fetch(`${url}/api/v1/sessions/${ids[1].id}/context`).then((r):Promise<any>=>r.json());expect(otherContext.artifacts).toHaveLength(0);
  const timeline=await fetch(`${url}/api/v1/sessions/${ids[2].id}/timeline?tag=bot%3Aalice`).then((r):Promise<any>=>r.json());
  expect(timeline.events.length).toBeGreaterThan(0);
  expect(timeline.events.every((event: any)=>event.tags.includes('bot:alice'))).toBe(true);
});
it.skipIf(!url)('registers new bot and team threads automatically through the actual CopilotBot server', async () => {
  const fixture = await launchVerificationServer({ ...process.env, OMB_OPEN_BRAIN_URL: url });
  try {
    const api = async (path: string, method='GET', body?: unknown):Promise<any> => {
      const r=await fetch(fixture.info.url+path,{method,headers:{'Content-Type':'application/json',origin:fixture.info.url},...(body?{body:JSON.stringify(body)}:{})});expect(r.ok,await r.clone().text()).toBe(true);return r.json();
    };
    const first=(await api('/api/bots','POST',{name:'Integration bot'})).bot;
    const second=(await api('/api/bots','POST',{name:'Integration peer'})).bot;
    const room=(await api('/api/groups','POST',{name:'Integration room',memberIds:[first.id,second.id]})).group;
    await api('/api/copilotbot/open-brain/retry','POST',{});
    const direct=await api(`/api/copilotbot/open-brain?threadId=${first.threadId}`);
    const team=await api(`/api/copilotbot/open-brain?threadId=${room.threadId}`);
    expect(direct.link.id).not.toBe(team.link.id);
    expect(team.link.scope).toContain('team:');
    const disk=JSON.parse(readFileSync(join(fixture.info.dataDir,'open-brain','state.json'),'utf8'));
    expect(disk.links[first.threadId].id).toBe(direct.link.id);
  } finally { await fixture.close(); }
});

it.skipIf(!url)('instructs real private and team turns and stores calls through the launched MCP bridge', async () => {
  const fixture = await launchVerificationServer({ ...process.env, OMB_OPEN_BRAIN_URL: url, FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([
    {server:'agents',name:'brain_record',input:{kind:'decision',title:'Turn decision',text:'Keep durable evidence in the session.',tags:['integration']}},
    {server:'agents',name:'brain_task',input:{content:'Verify next run',tags:['integration']}}
  ]) });
  const api = async (path:string, method='GET', body?:unknown):Promise<any> => { const r=await fetch(fixture.info.url+path,{method,headers:{'Content-Type':'application/json',origin:fixture.info.url},...(body?{body:JSON.stringify(body)}:{})});expect(r.ok,await r.clone().text()).toBe(true);return r.json(); };
  try {
    const bot=(await api('/api/bots','POST',{name:'Evidence author'})).bot;
    const peer=(await api('/api/bots','POST',{name:'Evidence peer'})).bot;
    const group=(await api('/api/groups','POST',{name:'Evidence team',memberIds:[bot.id,peer.id]})).group;
    await api(`/api/groups/${group.id}/setup`,'PATCH',{action:'complete',bulletin:'Test evidence capture',defaultResponder:{kind:'member',botId:bot.id}});
    for (const room of [undefined,group]) {
      const thread=room?.threadId ?? bot.threadId;
      await api(room?`/api/groups/${room.id}/messages`:`/api/bots/${bot.id}/messages`,'POST',{text:room?'@Evidence author Please decide and track the next step.':'Please decide and track the next step.',threadId:thread});
      await expect.poll(async()=>{
        const state=await api(`/api/copilotbot/open-brain?threadId=${thread}`);
        if(!state.link) return 0;
        const context=await fetch(`${url}/api/v1/sessions/${state.link.id}/context`).then((r):Promise<any>=>r.json());
        return context.artifacts.length && context.todos.length;
      },{timeout:30_000}).toBeGreaterThan(0);
      const state=await api(`/api/copilotbot/open-brain?threadId=${thread}`);
      const tasks=await fetch(`${url}/api/v1/todos?session_id=${state.link.id}`).then((r):Promise<any>=>r.json());expect(tasks.todos.length).toBeGreaterThan(0);
      const dump=JSON.parse(readFileSync(fixture.fixtureDumpPath,'utf8'));
      expect(dump.systemPrompt).toContain('Open Brain is the durable workspace');
      expect(dump.systemPrompt).toContain(state.link.id);
      expect(dump.mcpConfig.mcpServers.agents.env.OMB_OPEN_BRAIN_ENABLED).toBe('1');
    }
  } finally { await fixture.close(); }
});
