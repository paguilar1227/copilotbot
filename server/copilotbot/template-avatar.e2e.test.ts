import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { launchVerificationServer } from '../../scripts/control-omb.ts';
import { parseBotTemplate } from './bot-templates.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

it('keeps built-in and custom avatars in bot/team templates after deleting the original bot and image', async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { 'content-type': 'application/json', origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any; expect(response.status, JSON.stringify(result)).toBe(status); return result;
  };
  try {
    const custom = (await api('POST', '/api/bots', { name: 'Portrait', section: 'Avatar team' }, 201)).bot;
    const mascot = (await api('POST', '/api/bots', { name: 'Star', section: 'Avatar team' }, 201)).bot;
    const directory = join(fixture.info.dataDir, 'attachments'); mkdirSync(directory, { recursive: true });
    const sourceFile = join(directory, 'source-avatar.png'); writeFileSync(sourceFile, Buffer.from(PNG, 'base64'));
    await api('PATCH', `/api/bots/${custom.id}`, { avatarUrl: '/api/attachments/source-avatar.png', avatarCrop: 'rounded', avatarZoom: 2, avatarFocusX: 0.25, avatarFocusY: 0.75 });
    await api('PATCH', `/api/bots/${mascot.id}`, { mascotBody: 'star', color: 'purple', title: 'Engineer', description: 'Build tools' });
    const portrait = await api('POST', '/api/copilotbot/roster/bots', { botId: custom.id }, 201);
    const team = await api('POST', '/api/copilotbot/roster/teams', { section: 'Avatar team' }, 201);
    const yaml = (await api('GET', `/api/copilotbot/roster/bots/${portrait.id}`)).yaml;
    expect(yaml).not.toContain('source-avatar.png');
    expect(parseBotTemplate(yaml).template.avatar).toEqual({ mime: 'image/png', data: PNG });
    const entries = (await api('GET', '/api/copilotbot/roster')).entries;
    const image = entries.find((entry: any) => entry.id === portrait.id).avatars[0];
    expect(image).toMatchObject({ avatarCrop: 'rounded', avatarZoom: 2, avatarFocusX: 0.25, avatarFocusY: 0.75 });
    expect(image.avatarUrl).not.toBe('/api/attachments/source-avatar.png');
    const previews = entries.find((entry: any) => entry.id === team.id).avatars;
    expect(previews).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Star', color: 'purple', mascotBody: 'star', title: 'Engineer', description: 'Build tools' }), expect.objectContaining({ name: 'Portrait', avatarUrl: image.avatarUrl })]));
    expect(JSON.stringify(entries)).not.toContain(PNG);
    await api('DELETE', `/api/bots/${custom.id}`); unlinkSync(sourceFile);
    const bytes = await (await fetch(fixture.info.url + image.avatarUrl)).arrayBuffer();
    expect(Buffer.from(bytes).toString('base64')).toBe(PNG);
    const preview = await api('POST', '/api/copilotbot/bot-template', { yaml });
    const recreated = (await api('POST', '/api/bots', { template: preview.defaults, useDefaults: false }, 201)).bot;
    expect(recreated).toMatchObject({ avatarUrl: image.avatarUrl, avatarCrop: 'rounded', avatarZoom: 2 });
    const deployment = await api('POST', '/api/copilotbot/roster/deploy', { requestId: randomUUID(), selections: [{ kind: 'team', id: team.id }] }, 201);
    const bots = (await api('GET', '/api/bots?messages=0')).bots.filter((bot: any) => deployment.deployments[0].botIds.includes(bot.id));
    expect(bots).toEqual(expect.arrayContaining([
      expect.objectContaining({ avatarUrl: image.avatarUrl, avatarCrop: 'rounded', avatarZoom: 2, avatarFocusX: 0.25, avatarFocusY: 0.75 }),
      expect.objectContaining({ mascotBody: 'star', color: 'purple', title: 'Engineer' }),
    ]));
    const largePng = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(1_000_000)]).toString('base64');
    const largeYaml = yaml.replace(PNG, largePng);
    expect((await api('POST', '/api/copilotbot/bot-template', { yaml: largeYaml })).defaults.avatar.data).toBe(largePng);
    const invalid = yaml.replace('image/png', 'image/svg+xml');
    await api('POST', '/api/copilotbot/bot-template', { yaml: invalid }, 400);
  } finally { await fixture.close(); }
});
