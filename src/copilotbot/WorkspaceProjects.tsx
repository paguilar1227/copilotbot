import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Folder, Pencil, Search, X } from 'lucide-react';
import { api, type Bot } from '@/state/store';
import { listenLiveFrames } from '@/lib/live-events';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import type { WorkspaceProject, WorkspaceProjectCatalog } from '../../shared/workspace-projects';

const endpoint = '/api/copilotbot/projects';
const field = 'w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink';
const button = 'rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised disabled:opacity-40';
export function useWorkspaceProjects(allowed: boolean, membershipKey: string) {
  const [catalog, setCatalog] = useState<WorkspaceProjectCatalog>({ projects: [], teams: [] });
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    if (!allowed) return;
    const current = ++generation.current;
    try {
      const next = await api<WorkspaceProjectCatalog>(endpoint);
      if (current === generation.current) { setCatalog(next); setError(''); }
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [allowed]);
  useEffect(() => {
    void reload();
    const focus = () => { void reload(); };
    window.addEventListener('focus', focus);
    const stop = listenLiveFrames({ onFrame: frame => { if (frame.kind === 'workspace-projects' || frame.kind === 'sections') void reload(); }, onMissedFrames: focus });
    return () => { generation.current++; stop(); window.removeEventListener('focus', focus); };
  }, [reload, membershipKey]);
  const mutate = async (method: string, project: Partial<WorkspaceProject>) => {
    if (running.current) return false;
    running.current = true; setPending(true); setError('');
    ++generation.current;
    try {
      const { id, ...body } = project;
      const next = await api<WorkspaceProjectCatalog>(endpoint + (id ? `/${id}` : ''), { method, body: JSON.stringify(body) });
      ++generation.current; setCatalog(next); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { running.current = false; setPending(false); }
  };
  return { catalog, error, pending, reload, mutate };
}

export function WorkspaceProjectSection({ project, count, expanded, pending, compact, onToggle, onEdit, children }: {
  project: WorkspaceProject; count: number; expanded: boolean; pending: boolean; compact: boolean;
  onToggle: () => void; onEdit: () => void; children: ReactNode;
}) {
  if (compact) return <div data-workspace-project={project.id}>{children}</div>;
  return <section data-workspace-project={project.id} aria-label={`Project ${project.name}`} className="mt-3 min-w-0">
    <div className="group flex min-w-0 items-center gap-1 rounded-lg bg-raised/40 pr-1">
      <button type="button" disabled={pending} onClick={onToggle} aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} project ${project.name}`}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-[13px] font-semibold text-ink disabled:opacity-50">
        {expanded ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
        <Folder size={14} className="shrink-0 text-ink-secondary" /><span className="truncate">{project.name}</span><span className="ml-auto text-[11px] font-normal text-ink-secondary">{count}</span>
      </button>
      <button type="button" onClick={onEdit} disabled={pending} aria-label={`Edit project ${project.name}`} className="rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink"><Pencil size={13} /></button>
    </div>
    {expanded && <div className="ml-2 border-l border-hairline/60 pl-1">{children}{count === 0 && <p className="px-3 py-3 text-[12px] text-ink-secondary">No teams or bots yet. Edit this project to add them.</p>}</div>}
  </section>;
}

export function WorkspaceProjectDialog({ project, catalog, bots, pending, error, onSave, onRemove, onClose }: {
  project: WorkspaceProject | null; catalog: WorkspaceProjectCatalog; bots: Bot[]; pending: boolean; error: string;
  onSave: (value: Partial<WorkspaceProject>) => Promise<boolean>; onRemove: () => Promise<boolean>; onClose: () => void;
}) {
  const [name, setName] = useState(project?.name ?? '');
  const [teams, setTeams] = useState(new Set(project?.teamIds ?? []));
  const [selectedBots, setSelectedBots] = useState(new Set(project?.botIds ?? []));
  const [query, setQuery] = useState('');
  const [removing, setRemoving] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  const standalone = bots.filter(bot => !bot.hidden && !bot.section);
  const teamOptions = catalog.teams.map(team => ({ ...team, owner: catalog.projects.find(p => p.id !== project?.id && p.teamIds.includes(team.id))?.name }));
  const botOptions = standalone.map(bot => ({ id: bot.id, name: bot.name, owner: catalog.projects.find(p => p.id !== project?.id && p.botIds.includes(bot.id))?.name }));
  const toggle = (selected: Set<string>, id: string) => new Set(selected.has(id) ? [...selected].filter(value => value !== id) : [...selected, id]);
  const lists = [
    { label: 'Teams', options: teamOptions, selected: teams, update: setTeams },
    { label: 'Individual bots', options: botOptions, selected: selectedBots, update: setSelectedBots },
  ];
  const save = async () => {
    if (await onSave({ ...(project ? { id: project.id, revision: project.revision } : {}), name: name.trim(), collapsed: project?.collapsed ?? false,
      teamIds: teamOptions.filter(item => teams.has(item.id)).map(item => item.id), botIds: botOptions.filter(item => selectedBots.has(item.id)).map(item => item.id) })) onClose();
  };
  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={event => { if (event.target === event.currentTarget && !pending) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby="workspace-project-title" ref={dialog} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-hairline bg-panel p-5 text-ink shadow-2xl"
      onKeyDown={event => {
        if (event.key === 'Escape' && !pending) { event.stopPropagation(); onClose(); }
        if (event.key === 'Tab') {
          const controls = dialog.current?.querySelectorAll<HTMLElement>('input:enabled, button:enabled');
          if (!controls?.length) return;
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <header className="mb-4 flex items-center justify-between gap-3"><h2 id="workspace-project-title" className="text-[17px] font-semibold">{project ? 'Edit project' : 'New project'}</h2><button type="button" className={button} disabled={pending} aria-label="Close project editor" onClick={onClose}><X size={16} /></button></header>
      <label className="block text-[13px] text-ink-secondary">Project name<input className={`${field} mt-1`} maxLength={60} value={name} disabled={pending} onChange={event => setName(event.target.value)} /></label>
      <p className="my-3 text-[12px] text-ink-secondary">Group teams and individual bots. A team’s bots follow its project. Selecting an item moves it from its current project.</p>
      <label className="relative mb-3 block"><Search size={14} className="absolute left-3 top-3 text-ink-secondary" /><input type="search" className={`${field} pl-8`} aria-label="Search project members" placeholder="Search teams and bots" value={query} onChange={event => setQuery(event.target.value)} /></label>
      {lists.map(list => <fieldset key={list.label} className="mb-3 rounded-xl border border-hairline px-3 pb-2"><legend className="px-1 text-[13px] font-medium">{list.label} · {list.options.filter(item => list.selected.has(item.id)).length} selected</legend>
        <div className="max-h-48 overflow-y-auto" role="region" aria-label={list.label} tabIndex={0}>
          {list.options.filter(item => item.name.toLowerCase().includes(query.toLowerCase())).map(item => <label key={item.id} className="flex items-start gap-3 border-b border-hairline/30 py-2 text-[13px]"><input type="checkbox" className="mt-1" aria-label={`Include ${list.label === 'Teams' ? 'team' : 'bot'} ${item.name}`} disabled={pending} checked={list.selected.has(item.id)} onChange={() => list.update(toggle(list.selected, item.id))} /><span className="min-w-0 break-words">{item.name}{item.owner && <span className="block text-[11px] text-ink-secondary">Currently in {item.owner}</span>}</span></label>)}
          {!list.options.some(item => item.name.toLowerCase().includes(query.toLowerCase())) && <p className="py-3 text-[12px] text-ink-secondary">{query ? 'No matches.' : list.label === 'Teams' ? 'Create a team to add it here.' : 'No bots outside teams.'}</p>}
        </div>
      </fieldset>)}
      {error && <p role="alert" className="my-3 text-[13px] text-danger">{error}</p>}
      <footer className="flex items-center justify-between gap-3">{project ? <button type="button" className={`${button} text-danger`} disabled={pending} onClick={() => setRemoving(true)}>Remove project</button> : <span />}<button type="button" className={button} disabled={pending || !name.trim()} onClick={() => void save()}>{pending ? 'Saving…' : 'Save project'}</button></footer>
    </div>
    <ConfirmDialog open={removing} title={`Remove ${project?.name}?`} body="Only the project divider is removed. Its teams, bots, chats and settings are kept and return to the main list." confirmLabel="Remove project" pending={pending} onCancel={() => setRemoving(false)} onConfirm={() => { void onRemove().then(success => { if (success) onClose(); else setRemoving(false); }); }} />
  </div>, document.body);
}
