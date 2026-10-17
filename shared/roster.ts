import type { ResourceAccess } from './bot-resources.ts';
import type { GroupDefaultResponder } from './wire.ts';

/** Saved definitions refer to other definitions, never to running bot IDs. */
export interface TeamTemplateDefinition {
  name: string;
  description: string;
  members: string[];
  resources: ResourceAccess;
  instructions: string;
  peers: Record<string, string[] | null>;
  rooms: Array<{ name: string; members: string[]; bulletin: string; responder: GroupDefaultResponder; cwd?: string }>;
}
export interface RosterSummary {
  id: string;
  kind: 'bot' | 'team';
  name: string;
  description: string;
  revision: number;
  memberCount: number;
  usedBy: Array<{ id: string; name: string }>;
  activeCopies: number;
}
export interface RosterBotDetail extends RosterSummary { kind: 'bot'; yaml: string }
export interface RosterTeamDetail extends RosterSummary { kind: 'team'; definition: TeamTemplateDefinition }
export type RosterDetail = RosterBotDetail | RosterTeamDetail;
export interface RosterDeployment { id: string; templateId: string; kind: 'bot' | 'team'; botIds: string[]; groupIds: string[]; section?: string; members?: Record<string, string> }
export interface RosterListing { entries: RosterSummary[] }
