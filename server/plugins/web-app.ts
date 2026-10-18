import { Readable } from 'node:stream';
import type { PluginHost } from './host.ts';
import { PASS, type RouteHandler } from '../routes/table.ts';

export function webAppRoutes(host: PluginHost, sessionLive: (id: string) => boolean): RouteHandler {
  return async ({ path, url, req, res, method, auth, json }) => {
    const match = /^\/api\/plugins\/([a-z][a-z0-9-]*)\/web\/([a-z][a-z0-9-]*)\/(.*)$/.exec(path);
    if (!match) return PASS;
    if (!auth.scopes.includes('admin')) return json(res, 403, { error: 'Open Brain requires owner access.' });
    try {
      const plugin = host.list().find(plugin => plugin.manifest.id === match[1]);
      const page = plugin?.manifest.pages.find(page => page.id === match[2]);
      if (!plugin?.enabled || !page?.webApp) return json(res, 409, { error: 'Enable this app extension first.' });
      const relative = decodeURIComponent(match[3]);
      if (relative.split('/').some(part => part === '..' || part === '.') || relative.includes('\\')) return json(res, 400, { error: 'Invalid service path' });
      const headers = new Headers();
      if (req.headers['content-type']) headers.set('content-type', req.headers['content-type']);
      const controller = new AbortController();
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      if (auth.kind === 'session' && !sessionLive(auth.session.id)) return json(res, 401, { error: 'Session expired' });
      const upstream = await host.requestService(plugin.manifest.id, page.webApp.service, '/' + relative + url.search, {
        method, headers, signal: controller.signal,
        ...(!['GET', 'HEAD'].includes(method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
      } as RequestInit);
      res.statusCode = upstream.status;
      for (const name of ['content-type', 'content-disposition', 'etag', 'last-modified']) { const value = upstream.headers.get(name); if (value) res.setHeader(name, value); }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!upstream.body) { res.end(); return; }
      for await (const part of upstream.body) { if (res.destroyed) break; res.write(part); }
      res.end();
    } catch (error) { if (!res.headersSent) json(res, 502, { error: error instanceof Error ? error.message : 'Open Brain is unavailable' }); else res.end(); }
  };
}
