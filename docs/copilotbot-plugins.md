# CopilotBot app extensions

Open **Apps → App extensions**. Open Brain Lite is included but starts disabled. Set its address if it runs somewhere other than this computer's port 3210, then enable it. Local Open Brain Lite needs no API token. The plugin connects to an existing installation; it does not start, stop, or modify that installation's containers.

Its Workspace page supports projects, notes, tasks, search, session handoffs, and consolidation. Its `plugin_open_brain_lite` MCP and `open-brain-lite` skill become available in the existing bot/team resource settings. Assign the skill from the bot's library; existing team limits still apply. Disabling the extension stops its backend, rejects pending commands, and removes its pages and contributions from subsequent requests. It does not erase project data or undo a request the external service has already accepted. Start a fresh agent session to discard any provider-cached tools from the previous session.

## Package contract, version 1

A plugin is a folder with `plugin.json`, optional backend JavaScript, and optional static page assets. Install the folder from App extensions. The host copies it into the private workspace's `plugins/packages` directory. Later source edits do not silently change the installed code. Disable a plugin before installing another version; its settings and storage survive. Previous package copies remain on disk.

```json
{
  "format": "copilotbot.plugin",
  "apiVersion": 1,
  "id": "project-board",
  "name": "Project Board",
  "version": "1.0.0",
  "description": "A small persistent project board",
  "backend": "backend.mjs",
  "pages": [{ "id": "board", "title": "Board", "entry": "ui/index.html" }],
  "commands": [{ "id": "read-board", "title": "Read board" }],
  "settings": {},
  "services": {},
  "mcp": [],
  "skills": []
}
```

An ESM backend exports `activate(context)`, returning a `commands` object with a function for every declared command. Bundle runtime dependencies into the package; the host does not run npm or installation scripts.

The independently installable [`plugins/examples/project-board`](../plugins/examples/project-board) package is a working example with a page, two commands, and persistent storage. It uses no Open Brain code or MCP server.

```js
export function activate(context) {
  return {
    commands: {
      'read-board': async () => (await context.storage.get('board')) ?? []
    }
  };
}
```

The context provides:

- `apiVersion`: currently `1`; incompatible manifests are rejected before execution.
- `settings`: non-secret values from the manifest's settings schema.
- `storage.get(key)` / `storage.set(key, json)`: durable JSON, isolated by plugin ID. Keys contain letters, digits, hyphens, and underscores.
- `services.request(name, path, { method, body })`: JSON requests to a declared service, relative to its configured URL. The host adds the optional bearer token and rejects redirects to prevent forwarding it elsewhere. HTTP failures include status but do not return upstream error bodies.

Settings support `text`, `url`, `boolean`, and `secret`, plus a label, description, required flag, and non-secret default. Secret values are kept in owner-readable workspace settings (file mode 0600), omitted from listings and the worker context, and added only to service requests. Do not put secrets in manifests, page code, URLs, or command results.

Services map a name to a `urlSetting` and optional `tokenSetting`. MCP entries map an existing service to its MCP path and a unique name beginning `plugin_` (up to 32 characters, matching the host MCP contract). Skills declare a unique name, description, and relative `SKILL.md` path. See the complete [Open Brain Lite package](../plugins/open-brain-lite/plugin.json).

## Page bridge

Pages run in an iframe with an opaque origin, scripts and form events enabled, and direct network, parent DOM, native form navigation, and popups blocked. JavaScript form handlers call the bridge and prevent the default submission. Use ordinary HTML/CSS/JavaScript; the host injects this API:

```js
const board = await window.copilotbot.invoke('read-board', {});
```

Only the currently mounted page's window and channel can request its plugin's declared commands. It cannot choose another plugin or call arbitrary host routes. Render user content with `textContent` or an equivalent escaping API. Pages should include a viewport meta tag, responsive layout, keyboard controls, and visible loading/error states.

Bundle page JavaScript and CSS into the HTML, as the included packages do. Direct network requests and external ES module imports are unavailable in the opaque-origin page; use backend commands for service access. The host passes its light/dark color scheme to the page.

## Trust and lifecycle

Installing and managing extensions requires owner/admin access. A backend runs in its own Node worker, so a crash cannot crash another plugin. **A worker is not an OS security sandbox:** installed backend code is trusted code with the user's Node/filesystem privileges. Page restrictions protect the app UI; they do not make a malicious backend safe. A disabled plugin's worker is terminated, including timers. Plugins should keep long-lived service processes outside the worker; start external services through their own deployment workflow.

No Open Brain-specific code lives in the host. Software Kitchen can use the same manifest, service adapter, page bridge, storage, and MCP/skill declarations. Its actual integration can be supplied as another package without rebuilding the host.

## Verification

Run `pnpm exec vitest run server/plugins/host.test.ts`. The tests use copied packages, isolated storage, two independent backends, local service fixtures, actual Node workers, and the authenticated route handler. They never mutate the user's Open Brain installation or contact a paid model.
