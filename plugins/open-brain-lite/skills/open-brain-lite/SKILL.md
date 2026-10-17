---
name: open-brain-lite
description: Keep project memory across sessions using Open Brain Lite. Use when continuing project work, retrieving decisions, or saving a handoff.
---

Use the Open Brain Lite MCP tools. Start with `list_projects` and resolve the project by name; do not invent its ID. Read `get_project_context` and use project-scoped `search` before repeating work or creating duplicate notes.

Keep factual decisions, verified outcomes, remaining work and source references in project notes or `save_session`. Use a stable session key so retries are idempotent. Do not save secrets. Content capture may return pending indexing: use `get` to check for ready or failed processing before claiming retrieval succeeds.

Run `consolidate_project` only when a new synthesis is needed. It starts a background job; poll project context for completed or failed status. Preserve prior evidence and distinguish a saved handoff from proven model improvement.
