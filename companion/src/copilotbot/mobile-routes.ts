/** Only these downstream routes are available to an authenticated companion.
 * Provider credentials, MCP installation and workspace configuration stay on
 * the computer. The route handlers retain their own admin checks. */
export const mobileRoutes = [
  { method: 'GET', path: /^\/api\/copilotbot\/projects$/ },
  { method: 'POST', path: /^\/api\/copilotbot\/projects$/ },
  { method: 'PUT', path: /^\/api\/copilotbot\/projects\/[\w-]+$/ },
  { method: 'PATCH', path: /^\/api\/copilotbot\/projects\/[\w-]+$/ },
  { method: 'DELETE', path: /^\/api\/copilotbot\/projects\/[\w-]+$/ },
  { method: 'PATCH', path: /^\/api\/copilotbot\/voice$/ },
  { method: 'POST', path: /^\/api\/instances\/(?:copilot|azure)\/auth\/(?:start|cancel)$/ },
  { method: 'GET', path: /^\/api\/instances\/(?:copilot|azure)\/auth\/status$/ },
  { method: 'GET', path: /^\/api\/copilotbot\/resources$/ },
  { method: 'PUT', path: /^\/api\/copilotbot\/resources$/ },
  { method: 'GET', path: /^\/api\/copilotbot\/bots\/[\w-]+\/(?:template|resources)$/ },
  { method: 'PUT', path: /^\/api\/copilotbot\/bots\/[\w-]+\/resources$/ },
  { method: 'POST', path: /^\/api\/copilotbot\/bot-templates?$/ },
  { method: 'GET', path: /^\/api\/bots\/[\w-]+\/learning$/ },
  { method: 'POST', path: /^\/api\/bots\/[\w-]+\/learning\/candidates\/[\w-]+\/(?:validate|trial|promote|rollback|reject|cases|revise|replay)$/ },
  { method: 'PATCH', path: /^\/api\/bots\/[\w-]+\/learning\/candidates\/[\w-]+\/evidence\/[\w-]+$/ },
  { method: 'PATCH', path: /^\/api\/bots\/[\w-]+\/learning\/runs\/[\w-]+$/ },
] as const;
