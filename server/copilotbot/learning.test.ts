import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { configureLearningAccess, LearningStore, packageVersion, type LearningSkill } from "./learning.ts";
import { createLearningHost } from "./learning-host.ts";
import { Store } from "../store.ts";
import { applyStagedSkillWrite, listSkills, readSkillFile, readSkillReferences, stageSkillWrite, setSkillEnabled } from "../skills.ts";
import type { LearningCandidate } from "../../shared/learning.ts";

const md = (text: string) => `---\nname: weekly-report\ndescription: Writes a weekly report.\n---\n\n# Report\n${text}\n`;
const files = (text: string) => [{ path: "SKILL.md", content: md(text) }, { path: "references/style.md", content: "Keep it precise." }];
const botId = "learner";
afterEach(() => configureLearningAccess(() => true));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "omb-learning-"));
  let current: LearningSkill[] = [{ name: "weekly-report", source: "learn:conversation", enabled: true, editable: true, files: files("old") }];
  let applied = 0;
  const deps = { root, skills: () => current, apply: (_: string, c: LearningCandidate) => { applied++; current = [{ ...current[0]!, files: c.files }]; return { stageId: "applied" }; },
    rollback: (_: string, c: LearningCandidate) => { current = [{ ...current[0]!, files: c.baseFiles, enabled: c.baseEnabled }]; } };
  const learning = new LearningStore(deps);
  const candidate = learning.propose(botId, { files: files("new"), source: "conversation", author: "explicit_learning", gist: "Correction", evidence: [{ kind: "task_outcome", quality: "verified", summary: "Owner observed a failed report", threadId: "source" }] });
  const get = () => learning.view(botId).candidates.find(c => c.id === candidate.id)!;
  const add = (kind: "motivating" | "variation") => learning.addCase(botId, candidate.id, get().revision, { kind, title: kind, prompt: `${kind} report`, environment: "Reset isolated notes fixture", workspace: root, checks: [{ kind: "output_includes", value: "correct" }] });
  const motivating = add("motivating"), variation = add("variation");
  const run = (caseId: string, arm: "baseline" | "candidate", output: string, options: { context?: unknown; runtime?: "live" | "fixture"; purpose?: "evaluation" | "trial"; used?: boolean; verify?: boolean; reportedModel?: string; readPath?: string } = {}) => {
    const threadId = randomUUID(), turnId = randomUUID();
    learning.pin(botId, { threadId, candidateId: candidate.id, caseId, arm, purpose: options.purpose ?? "evaluation" });
    const prompt = learning.prepare(botId, threadId, { text: get().cases.find(c => c.id === caseId)!.prompt, context: options.context ?? { model: "model", tools: ["read"], environment: "fixture-v1" }, runtime: options.runtime ?? "live" });
    const base = { eventId: randomUUID(), threadId, turnId, provider: "test", createdAt: new Date().toISOString() };
    learning.observe({ ...base, type: "turn.started" });
    if (options.readPath) learning.observe({ ...base, type: "item.started", itemType: "tool", itemId: "read", title: "Read", input: options.readPath });
    if (options.reportedModel) learning.observe({ ...base, type: "session.started", sessionId: "session", model: options.reportedModel });
    learning.observe({ ...base, type: "item.completed", itemType: "assistant_text", text: output });
    learning.observe({ ...base, type: "turn.completed", ok: true, usage: { input: 20, output: 10 } });
    const result = learning.view(botId).runs.at(-1)!;
    if (options.verify !== false) learning.verifyRun(botId, result.id, { used: arm === "candidate" && options.used !== false ? [candidate.name] : [], quality: "verified" });
    return { result, prompt };
  };
  const pairs = () => { for (const c of [motivating, variation]) { run(c.id, "baseline", "wrong"); run(c.id, "candidate", "correct"); } };
  const change = (action: "validate" | "trial" | "promote" | "rollback" | "reject") => learning.change(botId, candidate.id, get().revision, action);
  return { root, deps, learning, candidate, get, run, pairs, change, motivating, variation, current: () => current, applied: () => applied };
}

describe("learning proof gates (synthetic events test orchestration, not model quality)", () => {
  it("keeps proposals inactive, matches pinned pairs, requires a trial, persists history and rolls back", () => {
    const f = setup();
    expect(f.applied()).toBe(0);
    expect(() => f.change("validate")).toThrow(/both replay arms/);
    f.pairs();
    expect(f.get().evaluation).toMatchObject({ ready: true, improved: true });
    f.change("validate"); f.change("trial");
    expect(() => f.change("promote")).toThrow(/successful trial/);
    const { prompt } = f.run(f.variation.id, "candidate", "correct", { purpose: "trial" });
    expect(prompt).toContain(md("new")); expect(prompt).toContain("references/style.md");
    f.change("promote"); expect(f.applied()).toBe(1);
    expect(packageVersion(f.current()[0]!.files)).toBe(f.candidate.version);
    expect(new LearningStore(f.deps).view(botId).candidates[0]!.phase).toBe("active");
    f.change("rollback"); expect(f.current()[0]!.files).toEqual(f.candidate.baseFiles);
    expect(f.learning.view(botId).events.map(e => e.action)).toContain("rollback");
  });

  it("rejects fixture results, missing use, unverified outcomes and a failed variation", () => {
    for (const options of [{ runtime: "fixture" as const }, { used: false }, { verify: false }]) {
      const f = setup();
      for (const c of [f.motivating, f.variation]) { f.run(c.id, "baseline", "wrong", options); f.run(c.id, "candidate", "correct", options); }
      expect(f.get().evaluation.ready).toBe(false);
      expect(() => f.change("validate")).toThrow();
    }
    const f = setup(); f.pairs(); f.run(f.variation.id, "candidate", "wrong");
    expect(f.get().evaluation.ready).toBe(false);
  });

  it("does not count equal success as improvement or mismatched models/environments as pairs", () => {
    const f = setup();
    for (const c of [f.motivating, f.variation]) { f.run(c.id, "baseline", "correct"); f.run(c.id, "candidate", "correct"); }
    expect(f.get().evaluation.improved).toBe(false);
    f.run(f.motivating.id, "candidate", "correct", { context: { model: "other" } });
    expect(f.get().evaluation.reasons.join()).toContain("differ");
  });

  it("rejects a trial from a different context and a stale compare-and-swap", () => {
    const f = setup(); f.pairs(); f.change("validate"); f.change("trial");
    f.run(f.motivating.id, "candidate", "correct", { purpose: "trial", context: { model: "other" } });
    expect(() => f.change("promote")).toThrow(/trial/);
    expect(() => f.learning.change(botId, f.candidate.id, 1, "promote")).toThrow(/changed/);
    f.deps.skills = () => [{ ...f.current()[0]!, files: files("concurrent edit") }];
    expect(() => f.change("promote")).toThrow(/base skill changed/);
  });

  it("rechecks resource policy on create, pin, prepare and promote", () => {
    const f = setup(); f.pairs(); f.change("validate"); f.change("trial");
    f.run(f.motivating.id, "candidate", "correct", { purpose: "trial" });
    f.learning.pin(botId, { candidateId: f.candidate.id, caseId: f.motivating.id, threadId: "blocked", purpose: "trial", arm: "candidate" });
    configureLearningAccess(() => false);
    expect(() => f.change("promote")).toThrow(/allowed/);
    expect(() => f.learning.prepare(botId, "blocked", { text: f.motivating.prompt, context: {}, runtime: "live" })).toThrow(/allowed/);
    expect(() => f.learning.pin(botId, { candidateId: f.candidate.id, caseId: f.motivating.id, threadId: "another", purpose: "trial", arm: "candidate" })).toThrow(/allowed/);
    expect(() => f.learning.propose(botId, { ...f.candidate, files: files("again"), evidence: [] })).toThrow(/allowed/);
  });

  it("treats loaded and read as distinct from used and redacts stored outcomes", () => {
    const f = setup();
    f.learning.prepare(botId, "normal", { text: "a report", context: {}, runtime: "live", selected: ["weekly-report"] });
    const base = { eventId: "event", threadId: "normal", turnId: "turn", provider: "test", createdAt: new Date().toISOString() };
    f.learning.observe({ ...base, type: "turn.started" });
    f.learning.observe({ ...base, type: "item.started", itemType: "tool", itemId: "read", title: "Read", input: "/skills/weekly-report/SKILL.md" });
    f.learning.observe({ ...base, type: "item.completed", itemType: "tool", itemId: "read", ok: false, output: "Authorization: Bearer secret-token-value-abcdef" });
    f.learning.observe({ ...base, type: "turn.completed", ok: false });
    const run = f.learning.view(botId).runs[0]!;
    expect(run.loaded).toHaveLength(1); expect(run.read).toEqual(["weekly-report"]); expect(run.used).toEqual([]);
    expect(readFileSync(join(f.root, `${botId}.json`), "utf8")).not.toContain("secret-token-value-abcdef");
  });

  it("cannot resurrect rejected evidence or use earlier passing runs after a failed rerun", () => {
    const f = setup(); f.pairs(); f.change("reject");
    expect(() => f.learning.evidence(botId, f.candidate.id, f.get().revision, f.candidate.evidence[0]!.id, "verified")).toThrow(/pending/);
    const g = setup(); g.pairs(); g.run(g.motivating.id, "candidate", "wrong", { verify: false });
    expect(g.get().evaluation.ready).toBe(false);
  });
});

it("integrates the real revision store: preserves references and restores enabled state on rollback", () => {
  const store = new Store(() => ({ instanceId: "test", model: "test" }));
  const bot = store.createBot({ name: "Learning fixture" });
  const staged = stageSkillWrite(bot.id, { action: "create", files: files("old"), source: "learn:fixture" });
  if ("error" in staged) throw new Error(staged.error);
  const installed = applyStagedSkillWrite(bot.id, staged.id, { expectedSha256: staged.sha256, expectedReferencesSha256: staged.referencesSha256 ?? null });
  expect(installed).not.toHaveProperty("error"); setSkillEnabled(bot.id, "weekly-report", false);
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "/learn correct the report" });
  store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "A verified result", turnId: "previous" });
  const host = createLearningHost(store);
  host.learning.prepare(bot.id, bot.threadId, { text: "/learn correct the report", context: {}, runtime: "fixture" });
  const c = host.propose(bot.id, bot.threadId, { targetName: "weekly-report", files: [{ path: "SKILL.md", content: md("new") }], source: "conversation", gist: "new", author: "explicit_learning" });
  expect(c.files).toEqual(files("new"));
  expect(readSkillFile(bot.id, c.name)).toBe(md("old"));
  expect(listSkills(bot.id).find(s => s.name === c.name)?.enabled).toBe(false);
  expect(c.evidence.map(e => e.kind)).toEqual(["user_instruction", "task_outcome"]);
  expect(host.explicit(bot.threadId)).toBe(true);
  expect(readSkillReferences(bot.id, c.name)).toEqual(files("old").slice(1));
  const revision = () => host.learning.view(bot.id).candidates.find(candidate => candidate.id === c.id)!;
  const contracts = (["motivating", "variation"] as const).map(kind => host.learning.addCase(bot.id, c.id, revision().revision, {
    title: kind, kind, prompt: `${kind} report`, workspace: tmpdir(), environment: "Reset fixture notes", checks: [{ kind: "output_includes", value: "correct" }],
  }));
  host.learning.evidence(bot.id, c.id, revision().revision, c.evidence[0]!.id, "verified");
  const record = (caseId: string, arm: "baseline" | "candidate", purpose: "evaluation" | "trial") => {
    const threadId = randomUUID(), turnId = randomUUID();
    host.learning.pin(bot.id, { candidateId: c.id, caseId, threadId, arm, purpose });
    host.learning.prepare(bot.id, threadId, { text: revision().cases.find(k => k.id === caseId)!.prompt, context: {}, runtime: "live" });
    const base = { eventId: randomUUID(), threadId, turnId, provider: "unit-test-events", createdAt: new Date().toISOString() };
    host.learning.observe({ ...base, type: "turn.started" });
    host.learning.observe({ ...base, type: "item.completed", itemType: "assistant_text", text: arm === "candidate" ? "correct" : "wrong" });
    host.learning.observe({ ...base, type: "turn.completed", ok: true });
    host.learning.verifyRun(bot.id, host.learning.view(bot.id).runs.at(-1)!.id, { used: arm === "candidate" ? [c.name] : [], quality: "verified" });
  };
  for (const contract of contracts) { record(contract.id, "baseline", "evaluation"); record(contract.id, "candidate", "evaluation"); }
  host.learning.change(bot.id, c.id, revision().revision, "validate");
  host.learning.change(bot.id, c.id, revision().revision, "trial");
  record(contracts[0]!.id, "candidate", "trial");
  host.learning.change(bot.id, c.id, revision().revision, "promote");
  expect(readSkillFile(bot.id, c.name)).toBe(md("new"));
  expect(listSkills(bot.id).find(s => s.name === c.name)?.enabled).toBe(true);
  host.learning.change(bot.id, c.id, revision().revision, "rollback");
  expect(readSkillFile(bot.id, c.name)).toBe(md("old"));
  expect(readSkillReferences(bot.id, c.name)).toEqual(files("old").slice(1));
  expect(listSkills(bot.id).find(s => s.name === c.name)?.enabled).toBe(false);
  expect(listSkills(bot.id).find(s => s.name === c.name)?.source).toBe("learn:fixture");

  expect(() => host.propose(bot.id, "someone-elses-thread", { files: files("new"), source: "conversation", gist: "x", author: "background_review" })).toThrow(/private/);
});

it("enforces owner-only routes, validates contracts, and pins the owner's replay workspace", async () => {
  const { learningRoutes } = await import("./learning-routes.ts");
  const store = new Store(() => ({ instanceId: "test", model: "test" }));
  const bot = store.createBot({ name: "Route fixture" });
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "/learn reports" });
  const { learning, propose } = createLearningHost(store);
  const candidate = propose(bot.id, bot.threadId, { files: files("proposed"), source: "conversation", gist: "report", author: "explicit_learning" });
  const route = learningRoutes(store, learning);
  const request = async (suffix: string, method: string, body: unknown, admin = true) => {
    let result: { status: number; body: any } | undefined;
    const { json, readBody } = await import("../harness/http.ts");
    await route({ req: {} as Parameters<typeof readBody>[0], res: {} as Parameters<typeof json>[0], url: new URL("http://127.0.0.1/"), path: `/api/bots/${bot.id}/learning${suffix}`, method,
      auth: { kind: "loopback", scopes: admin ? ["admin", "client"] : ["client"] }, readBody: async () => body as Record<string, unknown>,
      json: (_res, status, data) => { result = { status, body: data }; } });
    return result!;
  };
  expect((await request("", "GET", undefined, false)).status).toBe(403);
  expect((await request(`/candidates/${candidate.id}/cases`, "POST", { revision: 1 })).status).toBe(400);
  const contract = await request(`/candidates/${candidate.id}/cases`, "POST", { revision: 1, title: "Report", kind: "motivating", prompt: "Write report", environment: "Clean local fixture", workspace: tmpdir(), checks: [{ kind: "output_includes", value: "fact" }] });
  expect(contract.status).toBe(201);
  const replay = await request(`/candidates/${candidate.id}/replay`, "POST", { caseId: contract.body.id, arm: "candidate", purpose: "evaluation" });
  expect(replay.status).toBe(201);
  expect(store.taskByThread(bot.id, replay.body.threadId)?.cwd).toBe(tmpdir());
  expect(learning.view(bot.id).pins[0]?.threadId).toBe(replay.body.threadId);
  expect((await request(`/candidates/${candidate.id}/trial`, "POST", { revision: 2 })).status).toBe(409);
  expect(learning.view(bot.id).candidates[0]?.phase).toBe("candidate");
});


it("keeps a disabled baseline absent and rejects a different task before dispatch", () => {
  const f = setup();
  const disabled = { ...f.current()[0]!, enabled: false };
  const learning = new LearningStore({ ...f.deps, root: mkdtempSync(join(tmpdir(), "omb-learning-disabled-")), skills: () => [disabled] });
  const candidate = learning.propose(botId, { files: files("enabled candidate"), source: "conversation", author: "owner", gist: "Enable better procedure", evidence: [] });
  const contract = learning.addCase(botId, candidate.id, candidate.revision, { title: "Report", kind: "motivating", prompt: "Report now", environment: "Reset notes", workspace: tmpdir(), checks: [{ kind: "output_includes", value: "correct" }] });
  learning.pin(botId, { candidateId: candidate.id, caseId: contract.id, threadId: "trial", purpose: "evaluation", arm: "baseline" });
  expect(() => learning.prepare(botId, "trial", { text: "A different task", context: {}, runtime: "live" })).toThrow(/exactly/);
  expect(learning.prepare(botId, "trial", { text: contract.prompt, context: {}, runtime: "live" })).toContain("baseline has no skill");
});


it("records the actual provider model and refuses a silent model change", () => {
  const f = setup(); f.pairs();
  const { result } = f.run(f.motivating.id, "candidate", "correct", { reportedModel: "fallback-model" });
  expect(result.reportedModel).toBe("fallback-model");
  expect(f.get().evaluation.ready).toBe(false);
  expect(f.get().evaluation.reasons.join()).toContain("differ");
});


it("does not overwrite an owner's intervening enable/disable decision", () => {
  const f = setup(); f.pairs(); f.change("validate"); f.change("trial");
  f.run(f.motivating.id, "candidate", "correct", { purpose: "trial" });
  f.current()[0]!.enabled = false;
  expect(() => f.change("promote")).toThrow(/settings changed/);
  expect(f.applied()).toBe(0);
});


it.each([
  "/bot/.agents/skills/weekly-report/references/style.md",
  JSON.stringify({ command: "cat references/style.md", cwd: "/bot/.agents/skills/weekly-report" }),
  JSON.stringify({ command: "cat references/style.md", cwd: "C:\\bot\\skills\\weekly-report" }),
])("rejects evaluation and trial runs that access a mutable package: %s", readPath => {
  const f = setup(); f.pairs();
  f.run(f.variation.id, "candidate", "correct", { readPath });
  expect(f.get().evaluation.ready).toBe(false);
  expect(f.get().evaluation.reasons.join()).toContain("mutable installed copy");
  const g = setup(); g.pairs(); g.change("validate"); g.change("trial");
  g.run(g.variation.id, "candidate", "correct", { purpose: "trial", readPath });
  expect(() => g.change("promote")).toThrow(/verified successful trial/);
  expect(g.applied()).toBe(0);
});

it("refuses an explicit learning update if the owner edits any package file after the turn starts", () => {
  const store = new Store(() => ({ instanceId: "test", model: "test" }));
  const bot = store.createBot({ name: "Stale learning" });
  const install = (action: "create" | "update", content: string) => {
    const stage = stageSkillWrite(bot.id, { action, targetName: "weekly-report", files: files(content), source: "learn:owner" });
    if ("error" in stage) throw new Error(stage.error);
    const applied = applyStagedSkillWrite(bot.id, stage.id, { expectedSha256: stage.sha256, expectedReferencesSha256: stage.referencesSha256 ?? null });
    expect(applied).not.toHaveProperty("error");
  };
  install("create", "original");
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "/learn revise weekly-report" });
  const host = createLearningHost(store);
  host.learning.prepare(bot.id, bot.threadId, { text: "/learn revise weekly-report", context: {}, runtime: "fixture" });
  const base = { eventId: "start", threadId: bot.threadId, turnId: "authoring-turn", provider: "test", createdAt: new Date().toISOString() };
  host.learning.observe({ ...base, type: "turn.started" });
  install("update", "owner correction");
  expect(() => host.propose(bot.id, bot.threadId, { targetName: "weekly-report", files: files("stale rewrite"), source: "conversation", gist: "outdated", author: "explicit_learning" })).toThrow(/base skill changed/);
  expect(readSkillFile(bot.id, "weekly-report")).toBe(md("owner correction"));
  expect(host.learning.view(bot.id).candidates).toEqual([]);
});
