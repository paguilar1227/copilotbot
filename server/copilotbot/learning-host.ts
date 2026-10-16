import { join } from "node:path";
import type { LearningCandidate, LearningEvidence } from "../../shared/learning.ts";
import { DATA_DIR } from "../config.ts";
import { listSkills, readSkillFile, readSkillReferences, stageSkillWrite, applyStagedSkillWrite, rejectStagedSkillWrite, setSkillEnabled } from "../skills.ts";
import type { Store } from "../store.ts";
import { parseLearnCommand, parseSaveRunRequest } from "../skill-learn.ts";
import { parseSkillMd } from "../skills.ts";
import { LearningError, LearningStore, packageVersion } from "./learning.ts";

export function createLearningHost(store: Store) {
  const skills = (botId: string) => listSkills(botId).map(skill => {
    const text = readSkillFile(botId, skill.name);
    const references = readSkillReferences(botId, skill.name);
    return { ...skill, files: text !== null && references !== null ? [{ path: "SKILL.md", content: text }, ...references] : [], editable: skill.editable && text !== null && references !== null };
  });
  const install = (botId: string, c: LearningCandidate, rollback: boolean) => {
    const files = rollback ? c.baseFiles : c.files;
    if (!rollback) {
      const current = skills(botId).find(s => s.name === c.name);
      if ((current ? packageVersion(current.files) : null) !== c.baseVersion) throw new LearningError("The base skill changed before activation.");
    }
    const staged = stageSkillWrite(botId, { action: rollback || c.baseVersion ? "update" : "create", targetName: c.name,
      files, source: rollback ? c.baseSource ?? `learn:${c.source}` : `learn:${c.source}`, gist: c.gist, keepReferences: false });
    if ("error" in staged) throw new LearningError(staged.error);
    const applied = applyStagedSkillWrite(botId, staged.id, { expectedSha256: staged.sha256, expectedReferencesSha256: staged.referencesSha256 ?? null });
    if ("error" in applied) { rejectStagedSkillWrite(botId, staged.id); throw new LearningError(applied.error); }
    if (!rollback) {
      const enabled = setSkillEnabled(botId, c.name, true);
      if ("error" in enabled) throw new LearningError(enabled.error);
    }
    return { stageId: staged.id };
  };
  const learning = new LearningStore({
    root: join(DATA_DIR, "learning"), skills,
    apply: (botId, c) => install(botId, c, false),
    rollback: (botId, c) => {
      const current = skills(botId).find(s => s.name === c.name);
      if (!current || packageVersion(current.files) !== c.version) throw new LearningError("This skill changed after activation. Rollback would overwrite another edit.");
      if (c.baseVersion) install(botId, c, true);
      const enabled = setSkillEnabled(botId, c.name, c.baseVersion ? c.baseEnabled : false);
      if ("error" in enabled) throw new LearningError(enabled.error);
    },
  });

  function propose(botId: string, threadId: string, input: { files: Array<{ path: string; content: string }>; source: string; gist: string; author: "explicit_learning" | "background_review"; baseSha256?: string; targetName?: string }) {
    const bot = store.bot(botId);
    if (!bot || !store.taskByThread(botId, threadId)) throw new LearningError("Learning is limited to this bot's private task conversations.");
    const messages = store.activePath(threadId);
    const evidence: Omit<LearningEvidence, "id">[] = [];
    const user = messages.findLast(m => m.role === "user" && m.kind === "text" && !m.sender && !m.peerAsk && !m.webhookPost);
    if (user?.text) evidence.push({ kind: "user_instruction", quality: "observed", summary: user.text, threadId, messageId: user.id });
    const reply = messages.findLast(m => m.role === "bot" && m.kind === "text" && m.text);
    if (reply?.text) evidence.push({ kind: "task_outcome", quality: "observed", summary: reply.text, threadId, messageId: reply.id, ...(reply.turnId ? { turnId: reply.turnId } : {}) });
    for (const message of messages) {
      if (message.turnId !== reply?.turnId || !message.tool || message.tool.setup) continue;
      evidence.push({ kind: "tool_result", quality: "observed", summary: `${message.tool.name}: ${message.tool.ok ? "succeeded" : "failed"} ${message.tool.summary ?? ""}`, threadId, messageId: message.id, turnId: message.turnId });
    }
    const main = input.files.find(f => f.path === "SKILL.md");
    const parsed = main && parseSkillMd(main.content);
    if (!parsed || "error" in parsed) throw new LearningError("Supply a valid SKILL.md.");
    if (input.targetName && input.targetName !== parsed.name) throw new LearningError("An update must retain its skill name.");
    const base = skills(botId).find(s => s.name === parsed.name);
    if (base && !input.targetName) throw new LearningError("This skill already exists. Read it and request an update.");
    const expectedBase = input.author === "explicit_learning" && input.targetName
      ? learning.baseVersionForTurn(botId, threadId, input.targetName) : undefined;
    if (input.author === "explicit_learning" && input.targetName && !expectedBase) {
      throw new LearningError("The skill's starting revision was not captured. Start a fresh /learn request before updating it.");
    }
    if (input.baseSha256 && listSkills(botId).find(s => s.name === parsed.name)?.sha256 !== input.baseSha256) throw new LearningError("The base skill changed after review.");
    const merged = new Map(base?.files.map(f => [f.path, f]) ?? []);
    for (const file of input.files) {
      if (file.path !== "SKILL.md" && !file.content.trim()) merged.delete(file.path);
      else merged.set(file.path, file);
    }
    const candidate = learning.propose(botId, { ...input, ...(expectedBase ? { baseVersion: expectedBase } : {}), files: [...merged.values()], evidence });
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `Learning candidate: ${candidate.name}`, ok: true,
      summary: `${candidate.gist} Saved inactive. Review evidence and task checks in Bot settings → Skills & MCPs → Learning.` } });
    return candidate;
  }
  function explicit(threadId: string): boolean {
    const user = store.activePath(threadId).findLast(m => m.role === "user" && m.kind === "text");
    return Boolean(user?.text && !user.sender && !user.peerAsk && !user.webhookPost && (parseLearnCommand(user.text) || parseSaveRunRequest(user.text)));
  }
  return { learning, propose, explicit };
}
