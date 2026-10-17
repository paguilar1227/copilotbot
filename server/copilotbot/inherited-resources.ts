import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { DATA_DIR, instanceConfigs, type AppConfig } from '../config.ts';
import { execCli } from '../procs.ts';
import { augmentedPath } from '../env-path.ts';
import { writeFileAtomic } from '../atomic.ts';
import { ACP_TIMEOUT_MS } from './copilot-catalog.mjs';
import type { ResourceAccess } from './resource-access.ts';
import type { ResourceRow } from '../../shared/bot-resources.ts';

export interface NativeResource extends ResourceRow { nativeName: string; kind: 'skills' | 'mcpServers'; managed?: boolean }
export interface CopilotResources { skills: NativeResource[]; mcpServers: NativeResource[] }
type Environment = Record<string, string | undefined>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const copilotResourceId = (instance: string, kind: string, name: string) => `copilot-${createHash('sha256').update(JSON.stringify([instance, kind, name])).digest('hex').slice(0, 24)}`;
export const copilotHome = (env: Environment) => env.COPILOT_HOME || join(env.HOME || env.USERPROFILE || homedir(), '.copilot');

function cliJSON(cli: string, args: string[], env: Environment, cwd: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execCli(cli, args, { env: { ...env, PATH: augmentedPath(), COPILOT_AUTO_UPDATE: 'false' }, cwd, timeout: ACP_TIMEOUT_MS, maxBuffer: Infinity }, (error, stdout) => {
      if (error) { reject(new Error(`Copilot could not list ${args[0]}. Check the CLI in Settings → Engines and refresh resources.`)); return; }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error(`Copilot returned an invalid ${args[0]} catalog. Update the CLI and refresh resources.`)); }
    });
  });
}

function appManagedSkill(path: string): boolean {
  try {
    const target = realpathSync(path);
    const root = join(DATA_DIR, 'workspaces');
    const within = relative(root, target);
    return !within.startsWith('..') && !isAbsolute(within) && within.split(/[\\/]/).includes('skills');
  } catch { return false; }
}

export async function discoverCopilotResources(cli: string, env: Environment, cwd: string, instanceId: string): Promise<CopilotResources> {
  const [skills, servers] = await Promise.all([cliJSON(cli, ['skill', 'list', '--json'], env, cwd), cliJSON(cli, ['mcp', 'list', '--json'], env, cwd)]);
  if (!Array.isArray(skills) || !record(servers) || !record(servers.mcpServers)) throw new Error('Copilot returned an unsupported resource catalog. Update the CLI and refresh resources.');
  const row = (kind: NativeResource['kind'], name: string, data: Record<string, unknown>, managed = false): NativeResource => ({
    name: managed ? name : copilotResourceId(instanceId, kind, name), nativeName: name, displayName: name,
    enabled: data.enabled !== false, origin: 'copilot', source: `Copilot · ${instanceId} · ${{ 'personal-copilot': 'Personal (.copilot)', 'personal-agents': 'Personal (.agents)', user: 'Personal (.copilot)', project: 'Project', plugin: 'Plugin', builtin: 'Built-in' }[String(data.source)] ?? String(data.source ?? 'Personal')}`,
    ...(typeof data.description === 'string' ? { description: data.description } : {}), ...(managed ? { managed: true } : {}), kind,
  });
  return {
    skills: skills.filter(record).filter(item => typeof item.name === 'string').map(item => row('skills', item.name as string, item, typeof item.path === 'string' && appManagedSkill(item.path))),
    mcpServers: Object.entries(servers.mcpServers).filter((entry): entry is [string, Record<string, unknown>] => record(entry[1])).map(([name, data]) => row('mcpServers', name, data)),
  };
}

export async function inheritedResourceCatalog(cfg: AppConfig, cwd = homedir(), selectedInstance?: string) {
  const resources: CopilotResources = { skills: [], mcpServers: [] };
  const warnings: string[] = [];
  for (const [id, instance] of Object.entries(instanceConfigs(cfg))) {
    if (instance.driver !== 'copilotAgent' || (selectedInstance && id !== selectedInstance)) continue;
    const env = { ...process.env, ...instance.environment };
    const cli = record(instance.config) && typeof instance.config.cli === 'string' ? instance.config.cli : 'copilot';
    try {
      const found = await discoverCopilotResources(cli, env, cwd, id);
      resources.skills.push(...found.skills.filter(skill => !skill.managed)); resources.mcpServers.push(...found.mcpServers);
    } catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
  }
  return { ...resources, warnings };
}

/** Copilot settings accept JSON comments and trailing commas. Strings are preserved verbatim. */
function settingsJSON(text: string): Record<string, unknown> {
  let plain = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { plain += ch; if (ch === '\\') plain += text[++i] ?? ''; else if (ch === '"') quoted = false; }
    else if (ch === '"') { quoted = true; plain += ch; }
    else if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; plain += '\n'; }
    else if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; }
    else if (ch !== ',' || !/^[\s]*[}\]]/.test(text.slice(i + 1))) plain += ch;
  }
  let value: unknown;
  try { value = JSON.parse(plain.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Copilot settings.json could not be read. Fix its JSON before applying resource limits.'); }
  if (!record(value)) throw new Error('Copilot settings must be a JSON object');
  return value;
}

export function prepareCopilotResourceHome(args: { env: Environment; instanceId: string; threadId: string; catalog: CopilotResources; policy: ResourceAccess; appMcpNames: string[] }): Environment {
  const source = copilotHome(args.env);
  if (!isAbsolute(source)) throw new Error('Copilot resource settings require an absolute Copilot home.');
  const home = join(DATA_DIR, 'providers', 'copilot-resources', createHash('sha256').update(JSON.stringify([args.instanceId, source])).digest('hex'), createHash('sha256').update(args.threadId).digest('hex'));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const settingsPath = join(source, 'settings.json');
  const settings = existsSync(settingsPath) ? settingsJSON(readFileSync(settingsPath, 'utf8')) : {};
  for (const name of ['config.json', 'permissions-config.json']) {
    const path = join(source, name);
    if (existsSync(path)) { copyFileSync(path, join(home, name)); chmodSync(join(home, name), 0o600); }
  }
  // Session files and credential directories remain shared; SQLite metadata stays private to avoid split WAL files.
  for (const name of ['skills', 'mcp-config.json', 'mcp-oauth-config', 'installed-plugins', 'plugin-data', 'session-state', 'AGENTS.md', 'agents', 'hooks', 'instructions', 'prompts']) {
    const path = join(source, name), link = join(home, name);
    if (!existsSync(path)) continue;
    try { lstatSync(link); }
    catch { symlinkSync(path, link, lstatSync(path).isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'); }
  }
  const names = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const disabled = (kind: 'skills' | 'mcpServers') => args.catalog[kind].filter(item => args.policy[kind] !== null && !args.policy[kind]!.includes(item.name)).map(item => item.nativeName);
  const disabledSkills = [...new Set([...names(settings.disabledSkills), ...disabled('skills')])];
  const disabledMcpServers = [...new Set([...names(settings.disabledMcpServers), ...disabled('mcpServers')])].filter(name => !args.appMcpNames.includes(name));
  writeFileAtomic(join(home, 'settings.json'), JSON.stringify({ ...settings, disabledSkills, disabledMcpServers }), { mode: 0o600 });
  return { ...args.env, COPILOT_HOME: home, COPILOTBOT_RESOURCE_POLICY: createHash('sha256').update(JSON.stringify({ disabledSkills, disabledMcpServers })).digest('hex') };
}
