import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { launchVerificationServer } from '../../scripts/control-omb.ts';

it('saves, edits, deploys and deletes roster definitions while preserving live copies and team references', async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { 'content-type': 'application/json', origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.status, `${path}: ${JSON.stringify(result)}`).toBe(status); return result;
  };
  try {
    const first = (await api('POST', '/api/bots', { name: 'Source researcher', section: 'Research' }, 201)).bot;
    const second = (await api('POST', '/api/bots', { name: 'Source reviewer', section: 'Research' }, 201)).bot;
    await api('PUT', '/api/copilotbot/resources?section=Research', { skills: [], mcpServers: [] });
    await api('POST', '/api/groups', { name: 'Review room', section: 'Research', memberIds: [first.id, second.id], setup: { bulletin: 'Review evidence.', defaultResponder: { kind: 'member', botId: second.id } } }, 201);
    const savedBot = await api('POST', '/api/copilotbot/roster/bots', { botId: first.id }, 201);
    const savedTeam = await api('POST', '/api/copilotbot/roster/teams', { section: 'Research' }, 201);
    let list = (await api('GET', '/api/copilotbot/roster')).entries;
    expect(list).toHaveLength(4);
    expect(list.find((entry: any) => entry.id === savedTeam.id)).toMatchObject({ memberCount: 2, activeCopies: 1 });
    const detail = await api('GET', `/api/copilotbot/roster/teams/${savedTeam.id}`);
    expect(detail.definition.rooms[0]).toMatchObject({ name: 'Review room', bulletin: 'Review evidence.', responder: { kind: 'member', botId: detail.definition.rooms[0].members[1] } });
    const member = detail.definition.members[0];
    const blocked = await api('DELETE', `/api/copilotbot/roster/bots/${member}`, { revision: 1 }, 409);
    expect(blocked.blockers).toEqual([{ id: savedTeam.id, name: 'Research' }]);
    const botDetail = await api('GET', `/api/copilotbot/roster/bots/${savedBot.id}`);
    await api('PUT', `/api/copilotbot/roster/bots/${savedBot.id}`, { revision: botDetail.revision, yaml: botDetail.yaml.replace('Source researcher', 'Reusable researcher') });
    expect((await api('GET', '/api/bots?messages=0')).bots.find((bot: any) => bot.id === first.id).name).toBe('Source researcher');
    const renamed = { ...detail.definition, name: 'Reusable research', description: 'Saved specialists' };
    await api('PUT', `/api/copilotbot/roster/teams/${savedTeam.id}`, { revision: detail.revision, definition: renamed });
    await api('PUT', `/api/copilotbot/roster/teams/${savedTeam.id}`, { revision: detail.revision, definition: renamed }, 409);
    const requestId = randomUUID();
    const deployBody = { requestId, selections: [{ kind: 'bot', id: savedBot.id }, { kind: 'team', id: savedTeam.id }] };
    const deployed = await api('POST', '/api/copilotbot/roster/deploy', deployBody, 201);
    expect(deployed.deployments).toHaveLength(2);
    const teamCopy = deployed.deployments.find((entry: any) => entry.kind === 'team');
    const allBots = (await api('GET', '/api/bots?messages=0')).bots;
    const count = allBots.length;
    expect(teamCopy.botIds).toHaveLength(2);
    for (const id of teamCopy.botIds) {
      expect(allBots.find((bot: any) => bot.id === id)).toMatchObject({ section: 'Reusable research', approvalMode: 'ask' });
      expect((await api('GET', `/api/copilotbot/bots/${id}/resources`)).effective).toEqual({ skills: [], mcpServers: [] });
    }
    const groups = (await api('GET', '/api/bots?messages=0')).groups;
    const groupCopy = groups.find((group: any) => group.id === teamCopy.groupIds[0]);
    expect([...groupCopy.memberIds].sort()).toEqual([...teamCopy.botIds].sort());
    expect(allBots.find((bot: any) => bot.id === groupCopy.defaultResponder.botId).name).toMatch(/^Source reviewer/);
    expect(groupCopy.threadId).toBeTruthy();
    expect((await api('POST', '/api/copilotbot/roster/deploy', deployBody)).replayed).toBe(true);
    expect((await api('GET', '/api/bots?messages=0')).bots).toHaveLength(count);
    const updated = await api('GET', `/api/copilotbot/roster/teams/${savedTeam.id}`);
    await api('PUT', `/api/copilotbot/roster/teams/${savedTeam.id}`, { revision: updated.revision, definition: { ...updated.definition, members: [updated.definition.members[1]], rooms: [], peers: {} } });
    await api('DELETE', `/api/copilotbot/roster/bots/${member}`, { revision: 1 });
    expect((await api('GET', '/api/bots?messages=0')).bots).toHaveLength(count);
    list = (await api('GET', '/api/copilotbot/roster')).entries;
    expect(list.find((entry: any) => entry.id === savedTeam.id)).toMatchObject({ memberCount: 1, activeCopies: 2 });
    const beforeInvalid = list.length;
    await api('POST', '/api/copilotbot/roster/bots', { yaml: 'profile: {}' }, 400);
    expect((await api('GET', '/api/copilotbot/roster')).entries).toHaveLength(beforeInvalid);
    const pairing = await api('POST', '/api/auth/pairing', { scopes: ['client'] });
    const paired = await api('POST', '/api/auth/pair', { code: pairing.code, label: 'Roster viewer' });
    const denied = await fetch(fixture.info.url + '/api/copilotbot/roster', { headers: { authorization: `Bearer ${paired.token}` } });
    expect(denied.status).toBe(403);
  } finally { await fixture.close(); }
});
