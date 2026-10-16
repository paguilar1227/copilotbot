import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import type { LearningView } from "../../shared/learning.ts";

it("captures explicit learning, dispatches pinned replays, and refuses fixture-based activation through the real server", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-learning-flow-"));
  const gate = join(scratch, "release");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const url = fixture.info.url;
  const api = async (path: string, method = "GET", body?: unknown, status = 200, token?: string): Promise<any> => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status); return result;
  };
  try {
    const { bot } = await api("/api/bots", "POST", { name: "Learning fixture" }, 201);
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "/learn report with verified facts", "--url", url]);
    let token = "";
    await expect.poll(() => { try { token = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN; } catch { return false; } return Boolean(token); }, { timeout: 15_000 }).toBe(true);
    const staged = await api("/api/internal/skills/stage", "POST", { action: "create", source: "conversation", skill_md: "---\nname: factual-report\ndescription: Write verified reports.\n---\n\n# Report\nCheck facts before reporting.\n", gist: "Check facts" }, 201, token);
    expect(staged).toMatchObject({ state: "candidate", name: "factual-report" });
    writeFileSync(gate, "finish");
    expect(await runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
    const base = `/api/bots/${bot.id}/learning`;
    const view = (): Promise<LearningView> => api(base);
    let candidate = (await view()).candidates[0]!;
    expect(candidate.phase).toBe("candidate"); expect(candidate.evidence[0]!.kind).toBe("user_instruction");
    await api(`/api/bots/${bot.id}/skills/factual-report`, "GET", undefined, 404);
    for (const kind of ["motivating", "variation"]) {
      await api(`${base}/candidates/${candidate.id}/cases`, "POST", { revision: candidate.revision, kind, title: kind, prompt: `${kind}: summarize fixture facts`, environment: "Disposable fixture notes; reset for each run", workspace: scratch, checks: [{ kind: "output_excludes", value: "imaginary fact" }] }, 201);
      candidate = (await view()).candidates[0]!;
    }
    await api(`${base}/candidates/${candidate.id}/evidence/${candidate.evidence[0]!.id}`, "PATCH", { revision: candidate.revision, quality: "verified" });
    for (const task of candidate.cases) {
      for (const arm of ["baseline", "candidate"]) {
        const prepared = await api(`${base}/candidates/${candidate.id}/replay`, "POST", { caseId: task.id, arm, purpose: "evaluation" }, 201);
        await runControlOmb(["send", "--bot", bot.id, "--task", prepared.threadId, "--text", prepared.prompt, "--url", url]);
        expect(await runControlOmb(["wait", "--bot", bot.id, "--task", prepared.threadId, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
        const run = (await view()).runs.findLast(r => r.threadId === prepared.threadId)!;
        expect(run).toMatchObject({ runtime: "fixture", arm, purpose: "evaluation", completedAt: expect.any(String), transportOk: true });
        expect(run.checks).toEqual([expect.objectContaining({ passed: true })]);
        const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
        expect(dump.systemPrompt).toContain(`Pinned evaluation skill: factual-report`);
        if (arm === "candidate") expect(dump.systemPrompt).toContain("Check facts before reporting.");
        await api(`${base}/runs/${run.id}`, "PATCH", { quality: "verified", used: arm === "candidate" ? ["factual-report"] : [] });
      }
    }
    candidate = (await view()).candidates[0]!;
    expect(candidate.evaluation.ready).toBe(false);
    const refused = await api(`${base}/candidates/${candidate.id}/validate`, "POST", { revision: candidate.revision }, 409);
    expect(refused.error).toContain("fixture runs cannot prove quality");
    await api(`${base}/candidates/${candidate.id}/promote`, "POST", { revision: candidate.revision }, 409);
    const { bot: other } = await api("/api/bots", "POST", { name: "Other fixture" }, 201);
    expect((await api(`/api/bots/${other.id}/learning`)).candidates).toEqual([]);
    expect((await view()).candidates[0]!.phase).toBe("candidate");
  } finally { await fixture.close(); }
}, 90_000);
