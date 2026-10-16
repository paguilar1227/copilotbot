export interface ResourceAccess {
  skills: string[] | null;
  mcpServers: string[] | null;
}
export interface ResourceState {
  policy: ResourceAccess;
  inherited: ResourceAccess;
  effective: ResourceAccess;
  catalog: {
    skills: Array<{ name: string; enabled: boolean; description?: string; origin?: "private" | "library" }>;
    mcpServers: Array<{ name: string; enabled: boolean }>;
  };
  busy: boolean;
}
