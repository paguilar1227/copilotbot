/** Learning records are local to one bot. A loaded version is not evidence that it was used successfully. */
export type EvidenceQuality = "observed" | "verified" | "disputed" | "expired";
export type LearningPhase = "candidate" | "validated" | "trial" | "active" | "rejected" | "rolled_back" | "superseded";
export interface LearningFile { path: string; content: string }
export interface LearningEvidence {
  id: string;
  kind: "user_instruction" | "tool_result" | "task_outcome";
  quality: EvidenceQuality;
  summary: string;
  threadId: string;
  turnId?: string;
  messageId?: string;
}
export interface LearningCheck {
  kind: "output_includes" | "output_excludes" | "tool_succeeded";
  value: string;
}
export interface LearningCase {
  id: string;
  title: string;
  kind: "motivating" | "variation";
  prompt: string;
  environment: string;
  workspace: string;
  checks: LearningCheck[];
  createdAt: string;
}
export interface LearningCandidate {
  id: string;
  revision: number;
  name: string;
  phase: LearningPhase;
  version: string;
  baseVersion: string | null;
  baseFiles: LearningFile[];
  baseEnabled: boolean;
  baseSource: string | null;
  files: LearningFile[];
  source: string;
  author: "owner" | "explicit_learning" | "background_review";
  gist: string;
  createdAt: string;
  evidence: LearningEvidence[];
  cases: LearningCase[];
  supersedes?: string;
  appliedStageId?: string;
}
export interface LearningRun {
  id: string;
  threadId: string;
  turnId: string;
  startedAt: string;
  completedAt?: string;
  candidateId?: string;
  caseId?: string;
  arm?: "baseline" | "candidate";
  purpose?: "evaluation" | "trial";
  runtime: "live" | "fixture";
  environmentHash: string;
  context: string;
  reportedModel?: string;
  ownerNote?: string;
  inputHash: string;
  loaded: Array<{ name: string; version: string; source: string }>;
  read: string[];
  used: string[];
  output: string;
  tools: Array<{ name: string; ok: boolean; output?: string }>;
  transportOk?: boolean;
  usage?: { input: number; output: number; cachedInput?: number };
  cost?: number | null;
  checks: Array<LearningCheck & { passed: boolean }>;
  ownerVerified?: boolean;
  quality: EvidenceQuality;
}
export interface LearningEvent {
  id: string;
  at: string;
  action: string;
  candidateId?: string;
  detail: string;
}
export interface LearningEvaluation {
  ready: boolean;
  improved: boolean;
  reasons: string[];
  pairs: Array<{ caseId: string; baselineRun: string; candidateRun: string; improved: boolean }>;
}
export interface LearningView {
  candidates: Array<LearningCandidate & { evaluation: LearningEvaluation }>;
  runs: LearningRun[];
  events: LearningEvent[];
  pins: Array<{ threadId: string; candidateId: string; caseId: string; arm: "baseline" | "candidate"; purpose: "evaluation" | "trial" }>;
}
