/** Sidebar organization only; team membership and permissions remain separate. */
export interface WorkspaceProject {
  id: string;
  name: string;
  revision: number;
  collapsed: boolean;
  teamIds: string[];
  botIds: string[];
}
export interface WorkspaceProjectCatalog {
  projects: WorkspaceProject[];
  teams: Array<{ id: string; name: string }>;
}

/** Pinning adds a shortcut; it never changes project membership. */
export function projectStandaloneBots<T extends { id: string; section?: string; hidden?: boolean }>(project: WorkspaceProject, bots: T[]): T[] {
  return bots.filter(bot => !bot.hidden && !bot.section?.trim() && project.botIds.includes(bot.id));
}
