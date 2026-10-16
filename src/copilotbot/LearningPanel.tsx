import { useEffect, useRef, useState, type FormEvent } from "react";
import { lineDiff } from "../../shared/line-diff";
import type { LearningCheck, LearningRun, LearningView } from "../../shared/learning";
import { useStore } from "@/state/store";
import { useBotEditor } from "@/components/bot-settings/BotEditorContext";

const button = "rounded-lg border border-hairline px-3 py-1.5 text-[12px] hover:bg-raised disabled:opacity-40";
const field = "w-full rounded-lg border border-hairline bg-inset p-2 text-[12px] text-ink";
type Candidate = LearningView["candidates"][number];
type Mutate = (path: string, body: unknown, method?: string) => Promise<void>;

function ContractForm({ candidate, mutate, busy }: { candidate: Candidate; mutate: Mutate; busy: boolean }) {
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const lines = String(data.get("checks")).split("\n").filter(line => line.trim());
    if (!lines.length || lines.some(line => !/^(includes|excludes|tool):\s*\S/.test(line.trim()))) {
      setError("Start each check with includes:, excludes: or tool:, followed by its expected value."); return;
    }
    setError("");
    const checks: LearningCheck[] = lines.map(line => {
      const at = line.indexOf(":");
      const kind = line.slice(0, at).trim();
      return { kind: kind === "excludes" ? "output_excludes" : kind === "tool" ? "tool_succeeded" : "output_includes", value: line.slice(at + 1).trim() };
    });
    await mutate(`candidates/${candidate.id}/cases`, { revision: candidate.revision, title: data.get("title"), kind: data.get("kind"),
      prompt: data.get("prompt"), environment: data.get("environment"), workspace: data.get("workspace"), checks });
  };
  return <details className="mt-3"><summary>Add task checks</summary>
    <form onSubmit={event => void submit(event)} className="mt-2 grid gap-2">
      <label>Task title<input name="title" required className={field} /></label>
      <label>Task kind<select name="kind" className={field}><option value="motivating">Motivating example</option><option value="variation">Unseen variation</option></select></label>
      <label>Exact task text<textarea name="prompt" required className={field} /></label>
      <label>Isolated environment and reset instructions<textarea name="environment" required className={field} /></label>
      <label>Absolute isolated workspace path<input name="workspace" required className={field} placeholder="/absolute/path/to/disposable-fixture" /></label>
      <label>Checks, one per line<textarea name="checks" required placeholder={"includes:expected text\nexcludes:unwanted text\ntool:Exact tool name"} className={field} /></label>
      <p>Define checks before running. Use a distinct variation to test whether the lesson generalizes. Reset the isolated environment between arms.</p>
      {error && <p role="alert" className="text-danger">{error}</p>}
      <button className={button} disabled={busy}>Save task contract</button>
    </form>
  </details>;
}

function Run({ run, name, mutate, busy, open }: { run: LearningRun; name: string; mutate: Mutate; busy: boolean; open: (thread: string) => void }) {
  const [used, setUsed] = useState(run.used);
  const skillNames = name ? [name] : run.loaded.map(skill => skill.name);
  const [note, setNote] = useState(run.ownerNote ?? "");
  return <details className="mt-2 rounded-lg border border-hairline p-2"><summary>{run.purpose ?? "Task"} · {run.arm ?? "active skills"} · {run.runtime} · {run.quality} · {run.completedAt ? run.transportOk ? "delivered" : "failed" : "in progress"}</summary>
    <p className="my-2 break-all">Run {run.id} · {run.startedAt}{run.completedAt && ` → ${run.completedAt}`}</p>
    <button className={button} onClick={() => open(run.threadId)}>Open task</button>
    <p>Observed model: {run.reportedModel ?? "not reported"}</p><p>Tokens: {run.usage ? `${run.usage.input} in / ${run.usage.output} out` : "not reported"} · Cost: {run.cost ?? "not reported"}</p>
    <pre className="my-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{run.output || "No answer recorded."}</pre>
    <ul>{run.checks.map((check, i) => <li key={i}>{check.passed ? "Pass" : "Fail"}: {check.kind} · {check.value}</li>)}</ul>
    <details><summary>Context, loaded/read versions and tools</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify({ context: run.context, loaded: run.loaded, read: run.read, tools: run.tools }, null, 2)}</pre></details>
    {run.completedAt && <div className="mt-2 flex flex-wrap items-center gap-2">
      <label className="w-full">Observed outcome, corrections and environment reset<textarea className={field} value={note} onChange={event => setNote(event.target.value)} /></label>
      <>{skillNames.map(skill => <label key={skill}><input type="checkbox" checked={used.includes(skill)} onChange={event => setUsed(current => event.target.checked ? [...new Set([...current, skill])] : current.filter(value => value !== skill))} /> I observed {skill} being used</label>)}</>
      <button className={button} disabled={busy} onClick={() => void mutate(`runs/${run.id}`, { used, quality: "verified", note }, "PATCH")}>Verify outcome and isolated environment</button>
      <button className={button} disabled={busy} onClick={() => void mutate(`runs/${run.id}`, { used: [], quality: "disputed" }, "PATCH")}>Dispute run</button>
      {run.runtime === "fixture" && <p>Fixture results test the workflow only; they cannot validate or activate learning.</p>}
    </div>}
  </details>;
}

function Revision({ candidate: c, runs, mutate, busy, open }: { candidate: Candidate; runs: LearningRun[]; mutate: Mutate; busy: boolean; open: (thread: string) => void }) {
  const action = (name: string) => void mutate(`candidates/${c.id}/${name}`, { revision: c.revision });
  const pending = ["candidate", "validated", "trial"].includes(c.phase);
  return <article className="rounded-xl border border-hairline bg-card p-3 text-[12px] leading-relaxed">
    <h4 className="text-[14px] font-semibold">{c.name} · {c.phase}</h4><p>{c.gist}</p>
    <p className="text-ink-secondary">{c.author} · {c.source} · revision {c.revision} · {c.createdAt}</p>
    <details><summary>Exact package changes and versions</summary>
      <p className="break-all">Current: {c.baseVersion ?? "No previous skill"}<br />Candidate: {c.version}</p>
      {[...new Set([...c.baseFiles, ...c.files].map(file => file.path))].map(path => <div key={path}>
        <h5>{path}</h5><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-inset p-2">{lineDiff(c.baseFiles.find(f => f.path === path)?.content ?? "", c.files.find(f => f.path === path)?.content ?? "").map((line, i) => <span key={i} className={line.startsWith("+") ? "block text-success" : line.startsWith("-") ? "block text-danger" : "block"}>{line}</span>)}</pre><div className="grid gap-2 sm:grid-cols-2">{[c.baseFiles, c.files].map((files, i) => <div key={i}><strong>{i ? "Candidate" : "Current"}</strong><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-inset p-2">{files.find(f => f.path === path)?.content ?? "(absent)"}</pre></div>)}</div>
      </div>)}
    </details>
    <details><summary>Source evidence ({c.evidence.length})</summary>{c.evidence.map(e => <div key={e.id} className="my-2 border-l border-hairline pl-2">
      <p>{e.kind} · {e.quality}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{e.summary}</pre>
      <button className={button} onClick={() => open(e.threadId)}>Open source task</button>
      {pending && (["verified", "disputed", "expired"] as const).map(quality => <button key={quality} className={button} disabled={busy} onClick={() => void mutate(`candidates/${c.id}/evidence/${e.id}`, { revision: c.revision, quality }, "PATCH")}>{quality === "verified" ? "Verify source" : quality === "disputed" ? "Mark wrong" : "Mark expired"}</button>)}
    </div>)}</details>
    {c.evaluation.reasons.length > 0 && <ul className="my-2 list-disc pl-4 text-ink-secondary">{c.evaluation.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
    {c.cases.map(task => <div key={task.id} className="my-2 rounded-lg bg-inset p-2"><strong>{task.title} · {task.kind}</strong><p className="whitespace-pre-wrap">{task.prompt}</p><p>Environment: {task.environment}</p><p>Workspace: {task.workspace}</p>
      <ul>{task.checks.map((check, i) => <li key={i}>{check.kind}: {check.value}</li>)}</ul>
      {pending && (["baseline", "candidate"] as const).map(arm => <button key={arm} className={button} disabled={busy} onClick={() => void mutate(`candidates/${c.id}/replay`, { caseId: task.id, arm, purpose: "evaluation" })}>Prepare {arm} run</button>)}
      {c.phase === "trial" && <button className={button} disabled={busy} onClick={() => void mutate(`candidates/${c.id}/replay`, { caseId: task.id, arm: "candidate", purpose: "trial" })}>Prepare pinned trial</button>}
    </div>)}
    {c.phase === "candidate" && <ContractForm candidate={c} mutate={mutate} busy={busy} />}
    <div className="my-3 flex flex-wrap gap-2">
      {c.phase === "candidate" && <button className={button} disabled={busy || !c.evaluation.ready} onClick={() => action("validate")}>Validate</button>}
      {c.phase === "validated" && <button className={button} disabled={busy || !c.evaluation.ready} onClick={() => action("trial")}>Start trial</button>}
      {c.phase === "trial" && <button className={button} disabled={busy || !c.evaluation.ready} onClick={() => action("promote")}>Activate verified version</button>}
      {["active", "trial"].includes(c.phase) && <button className={button} disabled={busy} onClick={() => action("rollback")}>Roll back</button>}
      {pending && <button className={button} disabled={busy} onClick={() => action("reject")}>Reject lesson</button>}
    </div>
    {pending && <details><summary>Revise as a new inactive candidate</summary><form className="grid gap-2" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void mutate(`candidates/${c.id}/revise`, { revision: c.revision, skillMd: data.get("skillMd"), gist: data.get("gist") }); }}>
      <label>Revised SKILL.md<textarea className={field} name="skillMd" required defaultValue={c.files.find(f => f.path === "SKILL.md")?.content} /></label>
      <label>Reason<input className={field} name="gist" required /></label><button disabled={busy} className={button}>Save revision</button>
    </form></details>}
    {runs.map(run => <Run key={run.id} run={run} name={c.name} mutate={mutate} busy={busy || !pending} open={open} />)}
  </article>;
}

export function LearningPanel({ botId, onSkillsChanged }: { botId: string; onSkillsChanged?: () => void | Promise<void> }) {
  const { request, draft } = useBotEditor();
  const { dispatch } = useStore();
  const [view, setView] = useState<LearningView>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const working = useRef(false);
  const base = `/api/bots/${botId}/learning`;
  const open = (threadId: string) => { dispatch({ type: "select", id: botId }); dispatch({ type: "switchTask", botId, threadId }); };
  const refresh = async (epoch = generation.current) => {
    try { const next = await request(base) as LearningView; if (epoch === generation.current) { setView(next); setError(""); } }
    catch (cause) { if (epoch === generation.current) setError(cause instanceof Error ? cause.message : "Could not load learning."); }
  };
  useEffect(() => {
    const epoch = ++generation.current;
    setView(undefined); setError(""); setNotice(""); setBusy(false); working.current = false;
    if (!draft) void refresh(epoch);
    return () => { generation.current++; };
  }, [botId, draft, request]);
  const mutate: Mutate = async (path, body, method = "POST") => {
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    const epoch = generation.current;
    try {
      const result = await request(`${base}/${path}`, { method, body: JSON.stringify(body) }) as { prompt?: string; threadId?: string; message?: string };
      if (epoch !== generation.current) return;
      if (result.prompt && result.threadId) setNotice(`${result.message}\nTask: ${result.threadId}\nPrompt: ${result.prompt}`);
      if (path.endsWith("/promote") || path.endsWith("/rollback")) await onSkillsChanged?.();
      await refresh(epoch);
    } catch (cause) { if (epoch === generation.current) setError(cause instanceof Error ? cause.message : "Learning operation failed."); }
    finally { if (epoch === generation.current) { working.current = false; setBusy(false); } }
  };
  if (draft) return null;
  return <section aria-label="Learning" className="mt-4 grid gap-3 text-[12px] text-ink">
    <div className="flex items-center justify-between"><h3 className="text-[15px] font-semibold">Learning</h3><button className={button} disabled={busy} onClick={() => void refresh()}>Refresh learning</button></div>
    <p>Lessons from /learn and background review stay inactive until task checks and a pinned trial pass. Owner verification attests actual use and a reset isolated environment. Reviewing text alone proves no improvement.</p>
    {error && <p role="alert" className="text-danger">{error}</p>}{notice && <pre role="status" className="whitespace-pre-wrap break-words rounded-lg bg-inset p-2">{notice}</pre>}
    {!view && !error && <p>Loading learning…</p>}{view?.candidates.length === 0 && <p>No learning candidates yet. Use /learn in a private conversation.</p>}
    {view?.pins.map(pin => <div key={pin.threadId}><button className={button} onClick={() => open(pin.threadId)}>Open prepared {pin.purpose} · {pin.arm}</button></div>)}
    {view?.candidates.map(candidate => <Revision key={`${candidate.id}:${candidate.revision}`} candidate={candidate} runs={view.runs.filter(run => run.candidateId === candidate.id)} mutate={mutate} busy={busy} open={open} />)}
    {view && view.runs.some(run => !run.candidateId) && <details><summary>Recent task usage</summary>{view.runs.filter(run => !run.candidateId).map(run => <Run key={run.id} run={run} name="" mutate={mutate} busy={busy} open={open} />)}</details>}
    {view && <details><summary>Learning history</summary>{view.events.map(event => <p key={event.id}>{event.at} · {event.action} · {event.detail}</p>)}</details>}
  </section>;
}
