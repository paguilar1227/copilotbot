import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { MAX_MCP_SERVERS, mcpServerNameError } from '../mcp-registry.ts';
import { writeFileAtomic } from '../atomic.ts';
import type { BotRecord } from '../store.ts';

export const resourceNamesSchema = z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64)).nullable();
export const resourceAccessSchema = z.object({
  skills: resourceNamesSchema.default(null),
  mcpServers: z.array(z.string().refine(name => mcpServerNameError(name) === null, 'Invalid MCP server name')).max(MAX_MCP_SERVERS).nullable().default(null),
}).strict();
export type ResourceAccess = z.infer<typeof resourceAccessSchema>;
const policiesSchema = z.object({ version: z.literal(1), teams: z.record(z.string(), resourceAccessSchema) }).strict();
export const unrestricted = (): ResourceAccess => ({ skills: null, mcpServers: null });

export function intersectResources(a: string[] | null | undefined, b: string[] | null | undefined): string[] | null {
  if (a == null) return b == null ? null : [...new Set(b)];
  const allowed = b == null ? null : new Set(b);
  return [...new Set(a)].filter(name => allowed === null || allowed.has(name));
}

export class ResourcePolicies {
  private readonly file: string;
  private readonly teamKey: (name?: string) => string;
  constructor(file: string, teamKey: (name?: string) => string) { this.file = file; this.teamKey = teamKey; }
  private read() {
    if (!existsSync(this.file)) return { version: 1 as const, teams: {} as Record<string, ResourceAccess> };
    return policiesSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
  }
  team(name?: string): ResourceAccess { return this.read().teams[this.teamKey(name)] ?? unrestricted(); }
  setTeam(name: string, policy: ResourceAccess): void {
    const data = this.read();
    data.teams[this.teamKey(name)] = resourceAccessSchema.parse(policy);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
  effective(bot: Pick<BotRecord, 'section' | 'skillAccess' | 'mcpServers'>): ResourceAccess {
    const team = this.team(bot.section);
    return { skills: intersectResources(bot.skillAccess, team.skills), mcpServers: intersectResources(bot.mcpServers, team.mcpServers) };
  }
}

// The host owns policy lookup; the skills module must not import the store singleton.
let lookup: (botId: string) => ResourceAccess = () => unrestricted();
export function configureResourceAccess(resolve: typeof lookup): void { lookup = resolve; }
export function skillAllowed(botId: string, name: string): boolean {
  const selected = lookup(botId).skills;
  return selected === null || selected.includes(name);
}
