// @vitest-environment happy-dom
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LearningPanel } from "./LearningPanel";
import type { LearningView } from "../../shared/learning";

const mocks = vi.hoisted(() => ({ request: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/components/bot-settings/BotEditorContext", () => ({ useBotEditor: () => ({ request: mocks.request }) }));
vi.mock("@/state/store", () => ({ useStore: () => ({ dispatch: mocks.dispatch }) }));
const view = (): LearningView => ({ candidates: [{ id: "c1", name: "weekly-report", phase: "candidate", revision: 2,
  version: "v2", baseVersion: "v1", baseFiles: [{ path: "SKILL.md", content: "old steps" }], files: [{ path: "SKILL.md", content: "new steps" }], baseEnabled: true, baseSource: "learn:previous",
  source: "conversation", author: "explicit_learning", createdAt: "2026-10-16T00:00:00Z", gist: "Verified report procedure",
  evidence: [{ id: "e1", kind: "user_instruction", quality: "observed", summary: "Check facts", threadId: "source" }],
  cases: [], evaluation: { ready: false, improved: false, reasons: ["No verified runs."], pairs: [] } }], runs: [], pins: [], events: [] });
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); mocks.request.mockReset(); mocks.dispatch.mockReset(); node = document.createElement("div"); document.body.append(node); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); });
const render = async (botId = "bot") => { await act(async () => root.render(createElement(LearningPanel, { botId }))); };
const click = async (text: string) => { const button = [...node.querySelectorAll("button")].find(b => b.textContent === text)!; expect(button).toBeTruthy(); await act(async () => button.click()); };

it("shows inactive proof, exact package versions and source; sends revision-guarded corrections", async () => {
  mocks.request.mockResolvedValue(view()); await render();
  expect(node.textContent).toContain("weekly-report · candidate"); expect(node.textContent).toContain("old steps"); expect(node.textContent).toContain("new steps");
  expect(node.textContent).toContain("No verified runs.");
  expect([...node.querySelectorAll("button")].find(b => b.textContent === "Validate")?.disabled).toBe(true);
  await click("Verify source");
  expect(mocks.request).toHaveBeenCalledWith("/api/bots/bot/learning/candidates/c1/evidence/e1", { method: "PATCH", body: JSON.stringify({ revision: 2, quality: "verified" }) });
  await click("Open source task");
  expect(mocks.dispatch).toHaveBeenLastCalledWith({ type: "switchTask", botId: "bot", threadId: "source" });
  await click("Reject lesson"); expect(mocks.request).toHaveBeenCalledWith("/api/bots/bot/learning/candidates/c1/reject", expect.anything());
});

it("does not show another bot's late learning response", async () => {
  let resolve!: (value: LearningView) => void;
  mocks.request.mockImplementationOnce(() => new Promise<LearningView>(done => { resolve = done; })).mockResolvedValue({ ...view(), candidates: [] });
  await render("first"); await render("second");
  await act(async () => resolve(view()));
  expect(node.textContent).toContain("No learning candidates yet."); expect(node.textContent).not.toContain("weekly-report");
});

it("shows server refusal without pretending the action succeeded", async () => {
  mocks.request.mockResolvedValueOnce(view()).mockRejectedValueOnce(new Error("The base skill changed.")); await render(); await click("Reject lesson");
  expect(node.querySelector('[role="alert"]')?.textContent).toBe("The base skill changed."); expect(node.textContent).toContain("candidate");
});

it("prepares and opens a replay without sending a model request", async () => {
  const v = view(); v.candidates[0]!.cases.push({ id: "case", title: "Report", kind: "motivating", prompt: "Write report", environment: "reset notes", workspace: "/tmp/fixture", checks: [{ kind: "output_includes", value: "fact" }], createdAt: "now" });
  mocks.request.mockResolvedValueOnce(v).mockResolvedValueOnce({ threadId: "replay", prompt: "Write report", message: "Nothing sent automatically." }).mockResolvedValueOnce({ ...v, pins: [{ threadId: "replay", candidateId: "c1", caseId: "case", purpose: "evaluation", arm: "candidate" }] });
  await render(); await click("Prepare candidate run"); expect(node.textContent).toContain("Nothing sent automatically.");
  await click("Open prepared evaluation · candidate"); expect(mocks.dispatch).toHaveBeenLastCalledWith({ type: "switchTask", botId: "bot", threadId: "replay" });
  expect(mocks.request.mock.calls.some(([path]) => String(path).includes("/messages"))).toBe(false);
});

it("refreshes the surrounding skill list after activation", async () => {
  const v = view(); v.candidates[0]!.phase = "trial"; v.candidates[0]!.evaluation.ready = true;
  const changed = vi.fn(); mocks.request.mockResolvedValue(v);
  await act(async () => root.render(createElement(LearningPanel, { botId: "bot", onSkillsChanged: changed })));
  await click("Activate verified version");
  expect(changed).toHaveBeenCalledOnce();
});


it("records real skill names for ordinary task usage", async () => {
  const v = view(); v.candidates = [];
  v.runs = [{ id: "run", threadId: "thread", turnId: "turn", startedAt: "now", completedAt: "now", runtime: "live", environmentHash: "hash", context: "{}", inputHash: "input", loaded: [{ name: "weekly-report", version: "v1", source: "learn:owner" }], read: [], used: [], output: "done", tools: [], checks: [], quality: "observed" }];
  mocks.request.mockResolvedValue(v); await render();
  const checkbox = node.querySelector('input[type="checkbox"]') as HTMLInputElement;
  await act(async () => checkbox.click());
  await click("Verify outcome and isolated environment");
  expect(mocks.request).toHaveBeenCalledWith("/api/bots/bot/learning/runs/run", { method: "PATCH", body: JSON.stringify({ used: ["weekly-report"], quality: "verified", note: "" }) });
});
