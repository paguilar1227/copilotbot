import type { ModelCatalog, EffortLevel } from '../contracts.ts';
import type { spawnCli, killCliTree } from '../procs.ts';
export const DEFAULT_MODEL: string;
export const ACP_TIMEOUT_MS: number;
export interface CopilotCatalog extends ModelCatalog {
  options: Array<ModelCatalog['options'][number] & { variants?: Array<{ id: EffortLevel; label: string }> }>;
}
export function discoverCopilot(input: { cli: string; env: Record<string, string | undefined>; spawn: typeof spawnCli; kill: typeof killCliTree; timeoutMs?: number; cwd?: string }): Promise<{ catalog: CopilotCatalog; version: string }>;
export function catalogFromSession(session: unknown): CopilotCatalog;
export function effortVariants(session: unknown): Array<{ id: EffortLevel; label: string }>;
