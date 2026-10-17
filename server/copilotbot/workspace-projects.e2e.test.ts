import { expect, it } from 'vitest';
import { launchVerificationServer } from '../../scripts/control-omb.ts';

it('groups teams and standalone bots, keeps team identity through rename, and removes only the divider', async () => {
  const fixture = await launchVerificationServer();
  const request = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { 'content-type': 'application/json', origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.status, JSON.stringify(result)).toBe(status); return result;
  };
  const endpoint = '/api/copilotbot/projects';
  try {
    const member = (await request('POST', '/api/bots', { name: 'Builder', section: 'Build team' }, 201)).bot;
    const solo = (await request('POST', '/api/bots', { name: 'Reviewer' }, 201)).bot;
    await request('PUT', '/api/copilotbot/resources?section=Build%20team', { skills: [], mcpServers: [] });
    const team = (await request('GET', endpoint)).teams.find((item: any) => item.name === 'Build team');
    let catalog = await request('POST', endpoint, { name: 'Release', teamIds: [team.id], botIds: [solo.id] }, 201);
    let project = catalog.projects[0];
    await request('POST', endpoint, { name: 'Invalid', botIds: [member.id] }, 400);
    catalog = await request('PATCH', `${endpoint}/${project.id}`, { revision: 1, collapsed: true });
    project = catalog.projects[0]; expect(project.collapsed).toBe(true);
    await request('PATCH', `${endpoint}/${project.id}`, { revision: 1, collapsed: false }, 409);
    await request('PATCH', '/api/sidebar-sections?section=Build%20team', { name: 'Delivery team' });
    catalog = await request('GET', endpoint);
    expect(catalog.teams.find((item: any) => item.name === 'Delivery team').id).toBe(team.id);
    catalog = await request('PUT', `${endpoint}/${project.id}`, { revision: project.revision, name: 'Launch', collapsed: true, teamIds: [team.id], botIds: [solo.id] });
    project = catalog.projects[0]; expect(project.name).toBe('Launch');
    catalog = await request('POST', endpoint, { name: 'Other', teamIds: [team.id] }, 201);
    expect(catalog.projects[0].teamIds).toEqual([]);
    expect(catalog.projects[0].botIds).toEqual([solo.id]);
    for (const item of catalog.projects) await request('DELETE', `${endpoint}/${item.id}`, { revision: item.revision });
    expect((await request('GET', endpoint)).projects).toEqual([]);
    const bots = (await request('GET', '/api/bots?messages=0')).bots;
    expect(bots.find((bot: any) => bot.id === member.id).section).toBe('Delivery team');
    expect(bots.some((bot: any) => bot.id === solo.id)).toBe(true);
    expect((await request('GET', '/api/copilotbot/resources?section=Delivery%20team')).policy).toEqual({ skills: [], mcpServers: [] });
  } finally { await fixture.close(); }
}, 60_000);
