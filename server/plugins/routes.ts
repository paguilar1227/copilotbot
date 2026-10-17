import { z } from 'zod';
import { PASS, type RouteHandler } from '../routes/table.ts';
import type { PluginHost } from './host.ts';
import { pluginMcpServer, pluginSkills } from './contributions.ts';

const bridge = `<script>
(() => {
  const channel = new URLSearchParams(location.hash.slice(1)).get('channel');
  const pending = new Map(); let next = 0;
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel) return;
    if (event.data.type === 'copilotbot:theme' && ['light', 'dark'].includes(event.data.scheme)) { document.documentElement.style.colorScheme = event.data.scheme; return; }
    if (event.data.type !== 'copilotbot:result') return;
    const task = pending.get(event.data.id); if (!task) return; pending.delete(event.data.id);
    event.data.error ? task.reject(new Error(event.data.error)) : task.resolve(event.data.result);
  });
  window.copilotbot = Object.freeze({ invoke(command, input) { return new Promise((resolve, reject) => {
    const id = String(++next); pending.set(id, {resolve, reject});
    parent.postMessage({type: 'copilotbot:command', channel, id, command, input}, '*');
  }); }});
})();
</script>`;

export function pluginRoutes(host: PluginHost): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const skill = /^\/api\/skills-library\/([a-z][a-z0-9-]*)$/.exec(path);
    if (skill && method === 'PATCH' && pluginSkills().some(row => row.name === skill[1])) {
      if (!auth.scopes.includes('admin')) return json(res, 403, { error: 'Changing plugin skills requires owner access.' });
      const body = z.object({ enabled: z.boolean() }).strict().safeParse(await readBody(req));
      if (!body.success) return json(res, 400, { error: 'enabled must be true or false' });
      return json(res, 200, { skill: await host.setSkillEnabled(skill[1]!, body.data.enabled) });
    }
    const managedMcp = /^\/api\/mcp\/servers\/(plugin_[a-z0-9_-]+)(?:\/.*)?$/.exec(path);
    if (managedMcp && pluginMcpServer(managedMcp[1]!) && method !== 'GET') return json(res, 409, { error: 'Manage this MCP server from its App extension settings.' });
    if (!path.startsWith('/api/plugins')) return PASS;
    if (!auth.scopes.includes('admin')) return json(res, 403, { error: 'App extensions require owner access.' });
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (path === '/api/plugins' && method === 'GET') return json(res, 200, { plugins: host.list(), ...(host.error ? { error: host.error } : {}) });
      if (path === '/api/plugins/install' && method === 'POST') {
        const body = z.object({ directory: z.string().min(1), trust: z.literal(true) }).strict().parse(await readBody(req));
        return json(res, 200, { plugin: await host.install(body.directory) });
      }
      const match = /^\/api\/plugins\/([a-z][a-z0-9-]*)\/(enable|settings|commands\/([a-z][a-z0-9-]*)|assets\/(.+))$/.exec(path);
      if (!match) return json(res, 404, { error: 'Plugin route not found' });
      const [, id, action, command, asset] = match;
      if (action === 'enable' && method === 'PUT') {
        const body = z.object({ enabled: z.boolean() }).strict().parse(await readBody(req));
        return json(res, 200, { plugin: await host.enable(id!, body.enabled) });
      }
      if (action === 'settings' && method === 'PUT') return json(res, 200, { plugin: await host.configure(id!, await readBody(req)) });
      if (command && method === 'POST') {
        const controller = new AbortController();
        const close = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', close);
        try { return json(res, 200, { result: await host.invoke(id!, command, await readBody(req), controller.signal) }); }
        finally { res.off('close', close); }
      }
      if (asset && method === 'GET') {
        const file = host.asset(id!, decodeURIComponent(asset));
        res.setHeader('Content-Type', `${file.mime}; charset=utf-8`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
        res.end(file.mime === 'text/html' ? file.body.toString('utf8').replace(/<head(?:\s[^>]*)?>/i, head => `${head}${bridge}`) : file.body);
        return;
      }
      return json(res, 405, { error: 'Method not allowed' });
    } catch (error) {
      return json(res, error instanceof z.ZodError ? 400 : (error as { status?: number }).status ?? 400, { error: error instanceof z.ZodError ? 'Invalid plugin request or manifest' : error instanceof Error ? error.message : 'Plugin request failed' });
    }
  };
}
