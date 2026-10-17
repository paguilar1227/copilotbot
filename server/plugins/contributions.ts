import type { StoredMcpServer } from '../mcp-registry.ts';

let servers: Record<string, StoredMcpServer> = {};
let skills: Array<{ name: string; file: string; description: string; plugin: string; enabled: boolean }> = [];

export function setPluginContributions(next: typeof servers, nextSkills: typeof skills): void { servers = next; skills = nextSkills; }
export function allMcpServers(configured: Record<string, unknown> = {}): Record<string, unknown> { return { ...servers, ...configured }; }
export function pluginMcpServer(name: string): StoredMcpServer | undefined { return servers[name]; }
export function pluginSkills(): typeof skills { return skills; }
