import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { LearningCandidate, LearningCase, LearningEvaluation, LearningEvidence, LearningFile, LearningRun, LearningView } from "../../shared/learning.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { writeFileAtomic } from "../atomic.ts";
import { redactSecretsInText } from "../redact.ts";
import { isSkillName, parseSkillMd } from "../skills.ts";
import { referenceLimitError, STAGED_SKILL_FILE_MAX_BYTES } from "../skill-storage.ts";

const text = z.string().min(1);
const qualitySchema = z.enum(["observed", "verified", "disputed", "expired"]);
const fileSchema = z.object({ path: text, content: z.string() }).strict();
const checkSchema = z.object({ kind: z.enum(["output_includes", "output_excludes", "tool_succeeded"]), value: text }).strict();
export const caseInputSchema = z.object({ title: text, kind: z.enum(["motivating", "variation"]), prompt: text, environment: text, workspace: text.refine(isAbsolute, "Use an absolute isolated workspace path."), checks: z.array(checkSchema).min(1) }).strict();
const caseSchema = caseInputSchema.extend({ id: text, createdAt: text });
const evidenceSchema = z.object({ id: text, kind: z.enum(["user_instruction", "tool_result", "task_outcome"]), quality: qualitySchema,
  summary: text, threadId: text, turnId: text.optional(), messageId: text.optional() }).strict();
const candidateSchema = z.object({ id: text, revision: z.number().int(), name: text,
  phase: z.enum(["candidate", "validated", "trial", "active", "rejected", "rolled_back", "superseded"]),
  version: text, baseVersion: text.nullable(), baseFiles: z.array(fileSchema), baseEnabled: z.boolean(), baseSource: text.nullable(), files: z.array(fileSchema),
  source: text, author: z.enum(["owner", "explicit_learning", "background_review"]), gist: text, createdAt: text,
  evidence: z.array(evidenceSchema), cases: z.array(caseSchema), supersedes: text.optional(), appliedStageId: text.optional() }).strict();
const loadedSchema = z.object({ name: text, version: text, source: text }).strict();
const runSchema = z.object({ id: text, threadId: text, turnId: text, startedAt: text, completedAt: text.optional(),
  candidateId: text.optional(), caseId: text.optional(), arm: z.enum(["baseline", "candidate"]).optional(), purpose: z.enum(["evaluation", "trial"]).optional(),
  runtime: z.enum(["live", "fixture"]), environmentHash: text, context: text, reportedModel: text.optional(), ownerNote: z.string().optional(), inputHash: text, baseVersions: z.record(z.string(), z.string()).optional(), loaded: z.array(loadedSchema), read: z.array(text), used: z.array(text),
  output: z.string(), tools: z.array(z.object({ name: text, ok: z.boolean(), output: z.string().optional() }).strict()), transportOk: z.boolean().optional(),
  usage: z.object({ input: z.number(), output: z.number(), cachedInput: z.number().optional() }).optional(), cost: z.number().nullable().optional(),
  checks: z.array(checkSchema.extend({ passed: z.boolean() })), ownerVerified: z.boolean().optional(), quality: qualitySchema }).strict();
const pinSchema = z.object({ threadId: text, candidateId: text, caseId: text, arm: z.enum(["baseline", "candidate"]), purpose: z.enum(["evaluation", "trial"]) }).strict();
const eventSchema = z.object({ id: text, at: text, action: text, candidateId: text.optional(), detail: z.string() }).strict();
const stateSchema = z.object({ version: z.literal(1), candidates: z.array(candidateSchema), runs: z.array(runSchema), pins: z.array(pinSchema), events: z.array(eventSchema) }).strict();
type State = z.infer<typeof stateSchema>;
type Pin = z.infer<typeof pinSchema>;

export const packageVersion = (files: readonly LearningFile[]) => createHash("sha256").update(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)))).digest("hex");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const clean = (value: string) => redactSecretsInText(value).replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
const pinCandidateName = (state: State, pin?: Pin) => state.candidates.find(c => c.id === pin?.candidateId)?.name;
const at = () => new Date().toISOString();
function referencesPackage(input: string, name: string): boolean {
  const paths = input.replaceAll("\\", "/").split(/["'\s,{}:;=]+/);
  return paths.some(path => path === name || path.startsWith(`${name}/`) || path.endsWith(`/${name}`) || path.includes(`/${name}/`));
}
let access: (botId: string, name: string) => boolean = () => true;
export function configureLearningAccess(allowed: typeof access): void { access = allowed; }

export class LearningError extends Error {
  status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}
function requireThat(condition: unknown, message: string): asserts condition { if (!condition) throw new LearningError(message); }

export interface LearningSkill {
  name: string;
  source: string;
  enabled: boolean;
  editable: boolean;
  files: LearningFile[];
}
export interface LearningDeps {
  root: string;
  skills(botId: string): LearningSkill[];
  apply(botId: string, candidate: LearningCandidate): { stageId: string };
  rollback(botId: string, candidate: LearningCandidate): void;
}
type Prepared = { botId: string; pin?: Pin; run: Omit<LearningRun, "turnId"> };

export function evaluate(candidate: LearningCandidate, runs: LearningRun[]): LearningEvaluation {
  const reasons: string[] = [];
  const pairs: LearningEvaluation["pairs"] = [];
  if (!candidate.evidence.some(e => e.quality === "verified")) reasons.push("Verify the source evidence before validation.");
  if (candidate.evidence.some(e => e.quality === "disputed" || e.quality === "expired")) reasons.push("Resolve disputed or expired evidence with a new candidate.");
  if (!candidate.cases.some(c => c.kind === "motivating")) reasons.push("Add a motivating task contract.");
  if (!candidate.cases.some(c => c.kind === "variation")) reasons.push("Add a distinct variation contract before running it.");
  for (const c of candidate.cases) {
    const eligible = runs.filter(r => r.candidateId === candidate.id && r.caseId === c.id && r.purpose === "evaluation" && r.completedAt);
    const baseline = eligible.findLast(r => r.arm === "baseline");
    const proposed = eligible.findLast(r => r.arm === "candidate");
    if (!baseline || !proposed) { reasons.push(`${c.title}: record and verify both replay arms.`); continue; }
    if ([baseline, proposed].some(r => !r.ownerVerified || r.quality !== "verified" || r.runtime !== "live")) {
      reasons.push(`${c.title}: verify both outcomes from real model runs; fixture runs cannot prove quality.`); continue;
    }
    if (baseline.environmentHash !== proposed.environmentHash || baseline.inputHash !== proposed.inputHash || baseline.reportedModel !== proposed.reportedModel) {
      reasons.push(`${c.title}: model, tools, environment or input differ.`); continue;
    }
    const expectedVersion = (run: LearningRun, version: string | null) => version === null
      ? !run.loaded.some(s => s.name === candidate.name)
      : run.loaded.some(s => s.name === candidate.name && s.version === version);
    if (!expectedVersion(baseline, candidate.baseEnabled ? candidate.baseVersion : null) || !expectedVersion(proposed, candidate.version)) {
      reasons.push(`${c.title}: the recorded skill versions do not match this revision.`); continue;
    }
    if (!baseline.transportOk) { reasons.push(`${c.title}: the baseline did not finish successfully.`); continue; }
    if (proposed.read.includes(candidate.name)) { reasons.push(`${c.title}: candidate read the mutable installed copy instead of only its pinned package.`); continue; }
    if (!proposed.used.includes(candidate.name)) { reasons.push(`${c.title}: confirm actual use of the pinned version.`); continue; }
    if (baseline.checks.length !== c.checks.length || proposed.checks.length !== c.checks.length) {
      reasons.push(`${c.title}: incomplete check results.`); continue;
    }
    if (!proposed.transportOk || proposed.tools.some(t => !t.ok) || !proposed.checks.every(check => check.passed)) reasons.push(`${c.title}: candidate has a failed check or tool failure.`);
    const improved = baseline.checks.some((check, i) => !check.passed && proposed.checks[i]?.passed);
    pairs.push({ caseId: c.id, baselineRun: baseline.id, candidateRun: proposed.id, improved });
  }
  const improved = pairs.some(pair => pair.improved);
  if (!improved) reasons.push("No measured improvement over the baseline checks yet.");
  return { ready: reasons.length === 0, improved, reasons, pairs };
}

export class LearningStore {
  private readonly deps: LearningDeps;
  private readonly preparing = new Map<string, Prepared>();
  private readonly running = new Map<string, { botId: string; runId: string; tools: Map<string, string> }>();
  constructor(deps: LearningDeps) { this.deps = deps; }

  private file(botId: string): string {
    requireThat(/^[\w-]+$/.test(botId), "Invalid bot ID.");
    requireThat(!existsSync(this.deps.root) || (lstatSync(this.deps.root).isDirectory() && !lstatSync(this.deps.root).isSymbolicLink()), "Learning storage must be a real directory.");
    return join(this.deps.root, `${botId}.json`);
  }
  private read(botId: string): State {
    const file = this.file(botId);
    if (!existsSync(file)) return { version: 1, candidates: [], runs: [], pins: [], events: [] };
    requireThat(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), "Learning record must be a regular file.");
    return stateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  }
  private write(botId: string, state: State): void {
    const file = this.file(botId);
    mkdirSync(this.deps.root, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, JSON.stringify(stateSchema.parse(state), null, 2) + "\n", { mode: 0o600 });
  }
  private event(state: State, action: string, detail: string, candidateId?: string): void {
    state.events.push({ id: randomUUID(), at: at(), action, detail: clean(detail), ...(candidateId ? { candidateId } : {}) });
  }
  private candidate(state: State, id: string, revision?: number): LearningCandidate {
    const c = state.candidates.find(c => c.id === id);
    requireThat(c, "No such learning candidate.");
    if (revision !== undefined) requireThat(c.revision === revision, "This candidate changed. Refresh before trying again.");
    return c;
  }
  private allowed(botId: string, name: string): void { requireThat(access(botId, name), "This skill is outside the bot's allowed skills."); }
  private unchanged(botId: string, c: LearningCandidate): void {
    this.allowed(botId, c.name);
    const current = this.deps.skills(botId).find(s => s.name === c.name);
    requireThat((current ? packageVersion(current.files) : null) === c.baseVersion, "The base skill changed. Create a new candidate from its current version.");
    requireThat(!current || (current.enabled === c.baseEnabled && current.source === c.baseSource), "The base skill settings changed. Create a new candidate.");
    requireThat(!current || current.editable, "Imported and shared skills cannot be overwritten by learning. Create a local complement.");
  }

  view(botId: string): LearningView {
    const state = this.read(botId);
    return { ...state, candidates: state.candidates.map(c => ({ ...c, evaluation: evaluate(c, state.runs) })) };
  }

  propose(botId: string, input: { files: LearningFile[]; source: string; author: LearningCandidate["author"]; gist: string; evidence: Omit<LearningEvidence, "id">[]; baseVersion?: string | null; supersedes?: string }): LearningCandidate {
    const files = input.files.map(file => ({ path: file.path, content: clean(file.content) }));
    const main = files.find(f => f.path === "SKILL.md");
    requireThat(main && files.filter(f => f.path === "SKILL.md").length === 1, "Supply exactly one SKILL.md.");
    requireThat(Buffer.byteLength(main.content) <= STAGED_SKILL_FILE_MAX_BYTES, "SKILL.md exceeds the existing learned-skill size limit.");
    const parsed = parseSkillMd(main.content);
    requireThat(!("error" in parsed), "error" in parsed ? parsed.error : "Invalid skill.");
    requireThat(isSkillName(parsed.name), "Invalid skill name.");
    requireThat(!referenceLimitError(files), referenceLimitError(files) ?? "Invalid references.");
    this.allowed(botId, parsed.name);
    const base = this.deps.skills(botId).find(s => s.name === parsed.name);
    requireThat(!base || base.editable, "Imported and shared skills cannot be overwritten by learning. Create a local complement.");
    const baseVersion = base ? packageVersion(base.files) : null;
    if (input.baseVersion !== undefined) requireThat(input.baseVersion === baseVersion, "The base skill changed after it was read.");
    const state = this.read(botId);
    const version = packageVersion(files);
    requireThat(version !== baseVersion, "This candidate does not change the skill.");
    const duplicate = state.candidates.find(c => c.version === version && c.name === parsed.name && c.baseVersion === baseVersion && c.baseEnabled === (base?.enabled ?? false) && c.baseSource === (base?.source ?? null) && !["rejected", "rolled_back", "superseded"].includes(c.phase));
    if (duplicate) return duplicate;
    const c: LearningCandidate = { id: randomUUID(), revision: 1, name: parsed.name, version, baseVersion, baseFiles: base?.files ?? [], baseEnabled: base?.enabled ?? false, baseSource: base?.source ?? null,
      files, phase: "candidate", source: clean(input.source), author: input.author, gist: clean(input.gist), createdAt: at(),
      evidence: input.evidence.map(e => ({ ...e, id: randomUUID(), summary: clean(e.summary) })), cases: [], ...(input.supersedes ? { supersedes: input.supersedes } : {}) };
    if (input.supersedes) {
      const previous = this.candidate(state, input.supersedes);
      requireThat(previous.phase !== "active", "Roll back the active version before superseding it.");
      requireThat(previous.name === c.name, "A revision must keep the same skill name.");
      previous.phase = "superseded"; previous.revision++;
      state.pins = state.pins.filter(p => p.candidateId !== previous.id);
    }
    state.candidates.push(c);
    this.event(state, "proposed", c.gist, c.id);
    this.write(botId, state);
    return c;
  }

  change(botId: string, id: string, revision: number, action: "validate" | "trial" | "promote" | "rollback" | "reject"): LearningCandidate {
    const state = this.read(botId);
    const c = this.candidate(state, id, revision);
    if (action === "rollback") {
      requireThat(c.phase === "active" || c.phase === "trial", "Only active or trial learning can be rolled back.");
      if (c.phase === "active") this.deps.rollback(botId, c);
      const restored = state.candidates.find(p => p.name === c.name && p.version === c.baseVersion && p.phase === "superseded");
      if (restored) { restored.phase = "active"; restored.revision++; }
      c.phase = "rolled_back";
    } else if (action === "reject") {
      requireThat(c.phase !== "active", "Roll back the active version before marking it wrong.");
      c.phase = "rejected";
    } else {
      this.unchanged(botId, c);
      const evaluation = evaluate(c, state.runs);
      requireThat(evaluation.ready, evaluation.reasons.join(" "));
      if (action === "validate") { requireThat(c.phase === "candidate", "Only a candidate can be validated."); c.phase = "validated"; }
      if (action === "trial") { requireThat(c.phase === "validated", "Validate the candidate before its trial."); c.phase = "trial"; }
      if (action === "promote") {
        requireThat(c.phase === "trial", "Run a verified trial before activation.");
        const trial = state.runs.findLast(r => r.candidateId === c.id && r.purpose === "trial" && r.completedAt);
        const evaluated = state.runs.find(r => evaluation.pairs.some(pair => pair.candidateRun === r.id)
          && trial && r.caseId === trial.caseId && r.environmentHash === trial.environmentHash
          && r.inputHash === trial.inputHash && r.reportedModel === trial.reportedModel);
        requireThat(trial && evaluated && trial.ownerVerified && trial.quality === "verified" && trial.runtime === "live"
          && trial.arm === "candidate" && trial.transportOk
          && trial.loaded.some(s => s.name === c.name && s.version === c.version)
          && trial.used.includes(c.name) && !trial.read.includes(c.name)
          && trial.checks.length === c.cases.find(k => k.id === trial.caseId)?.checks.length
          && trial.checks.every(k => k.passed) && trial.tools.every(t => t.ok), "No verified successful trial with this version and context yet.");
        const applied = this.deps.apply(botId, c);
        for (const previous of state.candidates.filter(p => p.name === c.name && p.phase === "active")) {
          previous.phase = "superseded"; previous.revision++;
        }
        c.appliedStageId = applied.stageId; c.phase = "active";
      }
    }
    c.revision++;
    if (["rejected", "rolled_back"].includes(c.phase)) state.pins = state.pins.filter(p => p.candidateId !== id);
    this.event(state, action, `${c.name}: ${c.phase}`, id);
    this.write(botId, state); return c;
  }

  addCase(botId: string, id: string, revision: number, input: z.infer<typeof caseInputSchema>): LearningCase {
    const state = this.read(botId); const c = this.candidate(state, id, revision);
    requireThat(c.phase === "candidate", "Task contracts are fixed once validation starts.");
    const data = caseInputSchema.parse(input);
    requireThat(!c.cases.some(existing => existing.prompt.trim() === data.prompt.trim()), "A variation must have different task text.");
    const value = { ...data, prompt: clean(data.prompt), title: clean(data.title), environment: clean(data.environment), checks: data.checks.map(check => ({ ...check, value: clean(check.value) })), id: randomUUID(), createdAt: at() };
    c.cases.push(value); c.revision++;
    this.event(state, "contract", value.title, id); this.write(botId, state); return value;
  }

  evidence(botId: string, id: string, revision: number, evidenceId: string, quality: LearningEvidence["quality"]): void {
    const state = this.read(botId); const c = this.candidate(state, id, revision);
    requireThat(["candidate", "validated", "trial"].includes(c.phase), "Only pending learning evidence can change.");
    const entry = c.evidence.find(e => e.id === evidenceId); requireThat(entry, "No such evidence.");
    entry.quality = quality; c.revision++;
    if (quality !== "verified") { c.phase = "candidate"; state.pins = state.pins.filter(p => p.candidateId !== id); }
    this.event(state, "evidence", `${entry.kind}: ${quality}`, id); this.write(botId, state);
  }

  checkPin(botId: string, input: Pin): void {
    const state = this.read(botId); const c = this.candidate(state, input.candidateId);
    this.unchanged(botId, c);
    requireThat(!["active", "rolled_back", "rejected", "superseded"].includes(c.phase), "This candidate cannot start a replay.");
    requireThat(input.purpose !== "trial" || c.phase === "trial", "Start the trial phase first.");
    requireThat(input.purpose !== "trial" || input.arm === "candidate", "A trial must use the candidate version.");
    requireThat(c.cases.some(k => k.id === input.caseId), "No such contract.");
    requireThat(!state.pins.some(p => p.threadId === input.threadId), "This chat already has a pinned replay.");
  }

  pin(botId: string, input: Pin): void {
    this.checkPin(botId, input);
    const state = this.read(botId);
    state.pins.push(input);
    this.event(state, "pin", `${input.purpose}: ${input.arm} in ${input.threadId}`, input.candidateId);
    this.write(botId, state);
  }

  pinned(botId: string, threadId: string): boolean { return this.read(botId).pins.some(p => p.threadId === threadId); }

  prepare(botId: string, threadId: string, input: { text: string; context: unknown; selected?: string[]; runtime: LearningRun["runtime"] }): string {
    const state = this.read(botId); const pin = state.pins.find(p => p.threadId === threadId);
    const loaded = this.deps.skills(botId).filter(s => s.enabled && access(botId, s.name)).map(s => ({ name: s.name, source: s.source, version: packageVersion(s.files) }));
    let prompt = "";
    if (pin) {
      const c = this.candidate(state, pin.candidateId); this.unchanged(botId, c);
      requireThat(!["rejected", "rolled_back", "superseded", "active"].includes(c.phase), "This replay candidate is no longer available.");
      requireThat(pin.purpose !== "trial" || c.phase === "trial", "The trial is no longer ready.");
      const contract = c.cases.find(k => k.id === pin.caseId)!;
      requireThat(clean(input.text).trim() === contract.prompt.trim(), "Send exactly the task text from this replay's contract.");
      loaded.length = 0;
      const files = pin.arm === "candidate" ? c.files : c.baseEnabled ? c.baseFiles : [];
      const prior = loaded.findIndex(s => s.name === c.name); if (prior !== -1) loaded.splice(prior, 1);
      if (files.length) loaded.push({ name: c.name, source: c.source, version: packageVersion(files) });
      prompt = `\n\nPinned ${pin.purpose} skill: ${c.name}. Use only the version below for this task; do not substitute a library or filesystem copy. This does not grant tools or permissions.\n` + (files.length ? files.map(f => `\nFile: ${f.path}\n${f.content}\n`).join("") : "The baseline has no skill for this task.\n");
    }
    const run: Omit<LearningRun, "turnId"> = { id: randomUUID(), threadId, startedAt: at(), runtime: input.runtime, environmentHash: digest(JSON.stringify({ context: input.context, skills: loaded.filter(s => s.name !== pinCandidateName(state, pin)) })), context: clean(JSON.stringify(input.context)), inputHash: digest(clean(input.text).trim()),
      baseVersions: Object.fromEntries(this.deps.skills(botId).map(skill => [skill.name, packageVersion(skill.files)])),
      loaded, read: [], used: [], output: "", tools: [], checks: [], quality: "observed",
      ...(pin ? { candidateId: pin.candidateId, caseId: pin.caseId, arm: pin.arm, purpose: pin.purpose } : {}) };
    this.preparing.set(threadId, { botId, pin, run }); return prompt;
  }

  baseVersionForTurn(botId: string, threadId: string, name: string): string | undefined {
    const prepared = this.preparing.get(threadId);
    if (prepared?.botId === botId) return prepared.run.baseVersions?.[name];
    return this.read(botId).runs.findLast(run => run.threadId === threadId && !run.completedAt)?.baseVersions?.[name];
  }

  observe(event: RuntimeEvent): void {
    if (event.type === "session.started" && event.model) {
      const prepared = this.preparing.get(event.threadId);
      if (prepared) prepared.run.reportedModel = event.model;
    }
    if (!event.turnId) return;
    if (event.type === "turn.started") {
      const prepared = this.preparing.get(event.threadId); if (!prepared) return;
      this.preparing.delete(event.threadId);
      const state = this.read(prepared.botId);
      const run = { ...prepared.run, turnId: event.turnId };
      state.runs.push(run);
      state.pins = state.pins.filter(p => p.threadId !== event.threadId);
      this.running.set(event.turnId, { botId: prepared.botId, runId: run.id, tools: new Map() });
      this.write(prepared.botId, state); return;
    }
    const active = this.running.get(event.turnId); if (!active) return;
    const state = this.read(active.botId); const run = state.runs.find(r => r.id === active.runId); if (!run) return;
    if (event.synthetic) {
      run.runtime = "fixture";
    }
    if (event.type === "session.started") {
      if (event.model) run.reportedModel = event.model;
    } else if (event.type === "item.started" && event.itemType === "tool") {
      active.tools.set(event.itemId ?? event.eventId, event.title ?? "Tool");
      const input = event.input ?? event.summary ?? "";
      for (const loaded of run.loaded) if (referencesPackage(input, loaded.name) && !run.read.includes(loaded.name)) run.read.push(loaded.name);
    } else if (event.type === "item.completed" && event.itemType === "tool") {
      run.tools.push({ name: active.tools.get(event.itemId ?? "") ?? "Tool", ok: event.ok, ...(event.output ? { output: clean(event.output) } : {}) });
    } else if (event.type === "item.completed" && event.itemType === "assistant_text" && !event.synthetic) {
      run.output += (run.output ? "\n" : "") + clean(event.text);
    } else if (event.type === "turn.completed") {
      run.completedAt = at(); run.transportOk = event.ok && !event.synthetic; run.usage = event.usage; run.cost = event.cost;
      const candidate = state.candidates.find(c => c.id === run.candidateId);
      const contract = candidate?.cases.find(c => c.id === run.caseId);
      run.checks = (contract?.checks ?? []).map(check => ({ ...check, passed: check.kind === "output_includes" ? run.output.includes(check.value) : check.kind === "output_excludes" ? !run.output.includes(check.value) : run.tools.some(t => t.ok && t.name === check.value) }));
      this.event(state, "outcome", `Run ${run.id}: ${run.transportOk ? "delivered" : "failed"}; outcome needs owner verification.`, run.candidateId);
      this.running.delete(event.turnId);
    } else return;
    this.write(active.botId, state);
  }

  verifyRun(botId: string, id: string, input: { used: string[]; quality: LearningRun["quality"]; note?: string }): void {
    const state = this.read(botId); const run = state.runs.find(r => r.id === id);
    requireThat(run?.completedAt, "Wait for the run to finish.");
    if (run.candidateId) requireThat(!["active", "superseded", "rejected", "rolled_back"].includes(this.candidate(state, run.candidateId).phase), "Roll back active learning before changing its proof.");
    requireThat(input.used.every(name => run.loaded.some(s => s.name === name)), "Only versions loaded into this run can be marked as used.");
    run.used = [...new Set(input.used)]; run.quality = input.quality; run.ownerVerified = input.quality === "verified";
    run.ownerNote = clean(input.note ?? "");
    if (input.quality !== "verified" && run.candidateId) {
      const c = this.candidate(state, run.candidateId);
      requireThat(c.phase !== "active", "Roll back the active version before disputing its proof.");
      if (["validated", "trial"].includes(c.phase)) { c.phase = "candidate"; c.revision++; }
    }
    this.event(state, "run-evidence", `${id}: ${input.quality}; used ${run.used.join(", ") || "none"}`, run.candidateId); this.write(botId, state);
  }
}
