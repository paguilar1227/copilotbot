function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}
function project(input) {
  const id = text(input?.projectId, 'Project');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid project ID');
  return id;
}

export async function activate(ctx) {
  const request = (path, method = 'GET', body) => ctx.services.request('brain', path, { method, ...(body === undefined ? {} : { body }) });
  return { commands: {
    status: () => request('/health'),
    projects: () => request('/api/v1/projects'),
    'create-project': input => request('/api/v1/projects', 'POST', { name: text(input?.name, 'Project name'), description: input?.description ?? '' }),
    context: input => request(`/api/v1/projects/${project(input)}/context`),
    notes: input => request(`/api/v1/content?type=note&project_id=${project(input)}`),
    'capture-note': input => request('/api/v1/content', 'POST', { type: 'note', title: text(input?.title, 'Title'), content: text(input?.content, 'Note'), project_ids: [project(input)] }),
    'create-todo': input => request('/api/v1/todos', 'POST', { content: text(input?.content, 'Task'), project_id: project(input) }),
    'save-session': input => request(`/api/v1/projects/${project(input)}/sessions`, 'POST', { session_key: text(input?.sessionKey, 'Session key'), summary: text(input?.summary, 'Summary'), decisions: input?.decisions ?? [], next_steps: input?.nextSteps ?? [] }),
    search: input => request('/api/v1/search', 'POST', { query: text(input?.query, 'Search'), ...(input?.projectId ? { project_id: project(input) } : {}) }),
    consolidate: input => request(`/api/v1/projects/${project(input)}/consolidate`, 'POST'),
  } };
}
