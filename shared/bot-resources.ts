export interface ResourceAccess {
  skills: string[] | null;
  mcpServers: string[] | null;
}
export interface ResourceRow {
  name: string;
  enabled: boolean;
  displayName?: string;
  description?: string;
  origin?: "private" | "library" | "copilot";
  source?: string;
}
export interface ResourceState {
  policy: ResourceAccess;
  inherited: ResourceAccess;
  effective: ResourceAccess;
  catalog: {
    skills: ResourceRow[];
    mcpServers: ResourceRow[];
  };
  busy: boolean;
  warnings?: string[];
}
