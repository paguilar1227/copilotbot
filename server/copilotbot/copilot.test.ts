import { describe, it, expect, vi } from 'vitest';
import { copilotSupport } from './copilot.ts';
import { DeviceAuthController } from '../drivers/device-auth.ts';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SendTurnInput } from '../contracts.ts';

const catalog = { default: 'gpt', options: [
  { id: 'gpt', label: 'GPT', variants: [{ id: 'high' as const, label: 'High' }] },
  { id: 'fast', label: 'Fast', variants: [] },
] };

describe('native Copilot', () => {
  it('offers individual models, validates separate effort and confirms it before sending', async () => {
    const support = copilotSupport(async () => ({ catalog, version: 'test' }));
    expect(support.effortLevels).toContain('high');
    expect(support.modelVariants).toBe(false);
    expect((await support.resolveModels!({}, { cli: 'copilot', fullAuto: false }, 'copilot')).options.map(m => m.id)).toEqual(['gpt', 'fast']);
    const turn = { model: 'gpt', effort: 'high' } as SendTurnInput;
    const request = vi.fn(async () => ({ configOptions: [{ id: 'model', currentValue: 'gpt' }, { id: 'reasoning_effort', currentValue: 'high' }] }));
    await support.configureSession!({ request, sessionId: 's', turn, env: {}, config: { cli: 'copilot', fullAuto: false }, sessionModels: [], notice: () => {} });
    expect(request).toHaveBeenCalledWith('session/set_config_option', { sessionId: 's', configId: 'reasoning_effort', value: 'high' });
    await expect(support.prepare({ ...turn, model: 'fast' })).rejects.toThrow('does not offer');
    await expect(support.configureSession!({ request: async () => ({}), sessionId: 's', turn, env: {}, config: { cli: 'copilot', fullAuto: false }, sessionModels: [], notice: () => {} })).rejects.toThrow('acknowledge');
  });
  it('waits for cold-start discovery before accepting a saved model and effort', async () => {
    let ready!: (value: { catalog: typeof catalog; version: string }) => void;
    const support = copilotSupport(() => new Promise(resolve => { ready = resolve; }));
    const discovering = support.resolveModels!({}, { cli: 'copilot', fullAuto: false }, 'copilot');
    let sent = false;
    const prepare = support.prepare({ model: 'gpt', effort: 'high' } as SendTurnInput).then(value => { sent = true; return value; });
    await Promise.resolve(); expect(sent).toBe(false);
    ready({ catalog, version: 'fixture' });
    await discovering;
    expect(await prepare).toMatchObject({ model: 'gpt', effort: 'high' });
  });
  it('does not inherit tokens that override a Copilot subscription login', () => {
    const env = { GH_TOKEN: 'foreign', GITHUB_TOKEN: 'foreign', COPILOT_GITHUB_TOKEN: 'foreign' };
    copilotSupport().transformEnv!(env, { cli: 'copilot', fullAuto: false }, 'copilot', {});
    expect(env).toEqual({});
  });
  it('connects turn-scoped tools through a private native config for Copilot 1.0.98', () => {
    const support = copilotSupport();
    const turn = { threadId: 'native-mcp-test', integrations: { custom: {
      notes: { command: 'node', args: ['notes.mjs'], env: { TEST_TOKEN: 'private-test-token' } },
      blocked: { command: 'node', args: ['blocked.mjs'], env: {} },
    } }, toolScope: { allow: ['native:*', 'mcp:notes:*'] } } as unknown as SendTurnInput;
    const args = support.spawnArgs({ cli: 'copilot', fullAuto: false }, turn);
    expect(args).toContain('--additional-mcp-config');
    expect(args.join(' ')).not.toContain('private-test-token');
    const path = args[args.indexOf('--additional-mcp-config') + 1]!.slice(1);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.keys(data.mcpServers)).toEqual(['notes']);
    expect(data.mcpServers.notes).toMatchObject({ type: 'local', tools: ['*'] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(support.restartOnMcpChange).toBe(true);
    support.releaseMcpFiles();
    expect(existsSync(path)).toBe(false);
  });
  it('runs device-code sign-in, exposes only the code, and confirms the resulting account', async () => {
    const cli = join(homedir(), 'fake-copilot-login.mjs');
    writeFileSync(cli, `console.error('First copy your code: ABCD-EFGH'); console.error('https://github.com/login/device'); setTimeout(() => process.exit(0), 20);`);
    const spec = copilotSupport().deviceSignIn!;
    const confirm = vi.fn(async () => true);
    const controller = new DeviceAuthController({ ...spec, signedIn: confirm }, { cli: `${process.execPath} ${cli}`, environment: () => ({ ...process.env }), onAuthenticated: async () => {} });
    try {
      const flow = await controller.start();
      expect(flow).toMatchObject({ userCode: 'ABCD-EFGH', authorizationUrl: 'https://github.com/login/device' });
      await expect.poll(() => controller.get(flow.flowId!), { timeout: 5000 }).toMatchObject({ phase: 'succeeded', authorizationUrl: null });
      expect(confirm).toHaveBeenCalledTimes(1);
    } finally { await controller.dispose(); }
  });
});
