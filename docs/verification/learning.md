# Learning candidates

All commands below use temporary homes; no keys or paid model calls are used.

```
PATH=/opt/homebrew/bin:$PATH pnpm exec vitest run --configLoader native server/copilotbot/learning.test.ts src/components/bot-settings/LearningPanel.test.ts server/skill-learn.test.ts server/skill-review.test.ts
PATH=/opt/homebrew/bin:$PATH pnpm exec vitest run --configLoader native server/copilotbot/learning.e2e.test.ts server/skill-review.e2e.test.ts
```

The first command checks the state machine, owner-only routes, revision guards,
package preservation, policy rechecks and real React interactions. Its synthetic
runtime events demonstrate control flow only. The second command launches the
isolated verification server from `scripts/control-omb.ts`. It captures `/learn`
and background-review proposals, sends pinned replays through the real chat
runtime and confirms that fixture results cannot authorize activation. It needs
permission to bind local ports.

In Bot settings → Skills → Learning, inspect the source evidence and both package
versions. Add a motivating task and a distinct variation with exact task text,
checks, a disposable workspace path and reset instructions. Prepare and run each
arm in its generated conversation, resetting the workspace between runs. Verify
actual skill use, outcomes and the isolated environment. The server compares
model selection, reported model when available, tools, prompt context, workspace,
other loaded versions and task text. Reading the mutable installed copy in a
candidate run prevents validation. Matching text checks alone do not establish
actual skill use; the owner's verification is part of the evidence.

Only real, owner-verified comparisons with a passing candidate and a measurable
baseline failure allow validation. A pinned successful trial matching the
validated context is then required for activation. Rollback restores the prior
package and enabled state; a newly created skill becomes disabled. An intervening
edit prevents overwriting it. Rejected and superseded candidates remain in history.
Learning records are local, owner-readable, and excluded from sharing payloads.

These tests do not demonstrate an improvement in real model quality. That claim
requires real task evidence collected under the owner's chosen isolated checks.
