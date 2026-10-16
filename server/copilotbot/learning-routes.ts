import { z } from "zod";
import type { Store } from "../store.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { caseInputSchema, LearningError, LearningStore } from "./learning.ts";

const revision = z.number().int().positive();
const bodySchema = z.object({ revision });
export function learningRoutes(store: Store, learning: LearningStore): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const match = /^\/api\/bots\/([\w-]+)\/learning(?:\/(.*))?$/.exec(path);
    if (!match) return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Only the workspace owner can inspect or change learning evidence." });
    const botId = match[1]!; const suffix = match[2] ?? "";
    const bot = store.bot(botId);
    if (!bot) return json(res, 404, { error: "No such bot." });
    try {
      if (!suffix && method === "GET") return json(res, 200, learning.view(botId));
      let route = /^candidates\/([\w-]+)\/(validate|trial|promote|rollback|reject)$/.exec(suffix);
      if (route && method === "POST") {
        const input = bodySchema.strict().parse(await readBody(req));
        if (bot.busy) throw new LearningError("Wait for this bot's current work to finish before changing learning.");
        return json(res, 200, learning.change(botId, route[1]!, input.revision, route[2] as "validate" | "trial" | "promote" | "rollback" | "reject"));
      }
      route = /^candidates\/([\w-]+)\/cases$/.exec(suffix);
      if (route && method === "POST") {
        const input = caseInputSchema.extend({ revision }).strict().parse(await readBody(req));
        return json(res, 201, learning.addCase(botId, route[1]!, input.revision, caseInputSchema.parse(Object.fromEntries(Object.entries(input).filter(([key]) => key !== "revision")))));
      }
      route = /^candidates\/([\w-]+)\/evidence\/([\w-]+)$/.exec(suffix);
      if (route && method === "PATCH") {
        const input = bodySchema.extend({ quality: z.enum(["observed", "verified", "disputed", "expired"]) }).strict().parse(await readBody(req));
        learning.evidence(botId, route[1]!, input.revision, route[2]!, input.quality); return json(res, 200, { ok: true });
      }
      route = /^candidates\/([\w-]+)\/revise$/.exec(suffix);
      if (route && method === "POST") {
        const input = bodySchema.extend({ skillMd: z.string().min(1), gist: z.string().min(1) }).strict().parse(await readBody(req));
        const previous = learning.view(botId).candidates.find(c => c.id === route![1]);
        if (!previous || previous.revision !== input.revision) throw new LearningError("This candidate changed. Refresh before trying again.");
        return json(res, 201, learning.propose(botId, { files: previous.files.map(f => f.path === "SKILL.md" ? { ...f, content: input.skillMd } : f),
          source: previous.source, author: "owner", gist: input.gist, evidence: previous.evidence, baseVersion: previous.baseVersion, supersedes: previous.id }));
      }
      route = /^candidates\/([\w-]+)\/replay$/.exec(suffix);
      if (route && method === "POST") {
        const input = z.object({ caseId: z.string(), arm: z.enum(["baseline", "candidate"]), purpose: z.enum(["evaluation", "trial"]) }).strict().parse(await readBody(req));
        const candidate = learning.view(botId).candidates.find(c => c.id === route![1]);
        const contract = candidate?.cases.find(c => c.id === input.caseId);
        if (!candidate || !contract) throw new LearningError("No such candidate task contract.");
        const probe = `validation-${candidate.id}`;
        learning.checkPin(botId, { ...input, candidateId: candidate.id, threadId: probe });
        const task = store.createTask(botId, `Learning · ${candidate.name} · ${contract.title} · ${input.arm}`, false, undefined, undefined, undefined, undefined, contract.workspace);
        if (!task) throw new LearningError("Could not create the evaluation chat.");
        learning.pin(botId, { ...input, candidateId: candidate.id, threadId: task.threadId });
        return json(res, 201, { threadId: task.threadId, prompt: contract.prompt, environment: contract.environment,
          message: "Prepare the specified isolated environment, then send this exact prompt in the new chat. Normal tool permissions apply; nothing was sent automatically." });
      }
      route = /^runs\/([\w-]+)$/.exec(suffix);
      if (route && method === "PATCH") {
        const input = z.object({ used: z.array(z.string()), note: z.string().optional(), quality: z.enum(["observed", "verified", "disputed", "expired"]) }).strict().parse(await readBody(req));
        learning.verifyRun(botId, route[1]!, input); return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "No such learning operation." });
    } catch (error) {
      if (error instanceof z.ZodError) return json(res, 400, { error: error.issues.map(e => e.message).join(" ") });
      return json(res, error instanceof LearningError ? error.status : 500, { error: error instanceof Error ? error.message : "Learning operation failed." });
    }
  };
}
