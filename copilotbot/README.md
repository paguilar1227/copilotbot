# CopilotBot

Downstream of [OpenMausBot](https://github.com/milind-soni/OpenMausBot), based on upstream commit `113ec83256971c62088a0bbd507c6fa3a2cd4091`.

## Set up

Install dependencies with `pnpm install --frozen-lockfile`. Node 24 or newer is required by upstream.

For development, run `node copilotbot/dev.mjs` and `pnpm dev` in separate terminals. The development server uses `~/.copilotbot`, independently of OpenMausBot. Set `OMB_DATA_DIR` explicitly to use another directory.

Build the macOS app with `node copilotbot/package.mjs`. It produces `release-copilotbot/mac-arm64/CopilotBot.app`. The app has its own bundle identifier, Keychain identity, and `~/.copilotbot` data directory. Upstream auto-updates are disabled for CopilotBot so they cannot overwrite downstream features. The source package metadata remains upstream-owned; the downstream packaging script supplies the branding.

For a local build, `node copilotbot/package.mjs --reuse-resources /Applications/OpenMausBot.app/Contents/Resources` reuses the installed upstream native runtimes while rebuilding the UI, server, companion, and Electron code. The installed app is read only. This optional shortcut targets macOS arm64. A distributable build needs a signing identity and notarization configured by its owner.

### GitHub Copilot

Open Settings → Engines → GitHub Copilot. If the CLI is missing, the setup card explains how to install it or select its path. **Set up Copilot** runs `copilot login --device-code`, shows the one-time code, and opens GitHub. The native CLI owns its credential. No token is copied into the app.

The model catalog comes from ACP. Models and reasoning effort use separate controls. Unsupported effort is rejected before a prompt is sent. The CLI must support ACP and `login --device-code`.

### Bot templates and resources

New bot → **Import YAML file** loads a reviewable draft. Nothing runs until **Create bot**. Bot settings → **Identity → Export YAML template** saves version 1 of `copilotbot/bot`, including model/effort, persona, permission preferences, voice, routines, resource selections and avatar appearance. Custom avatar images travel inside the template. Credentials, grants, conversation history, learned memory and other attached files are excluded. Review free-text instructions and the avatar before sharing them.

**Skills & MCPs** appears in bot settings and team settings. Choose all available resources, selected names, or none. Team choices limit every member, including future members; individual choices can narrow them further. Changes wait until affected bots are idle. A selected skill must also be installed, assigned and enabled. Imported templates report missing or disabled resources; they never install servers or transfer sign-ins. Skill references use the local shared library; private skills must be added to the new bot separately.

These choices control the app's skill index, managed native skill links, skill tools and configured MCP mounts. They are not a filesystem sandbox or a replacement for a CLI's independently configured plugins. Team policies are stored separately from upstream settings, using stable team identifiers that survive renames.

Each resource list has its own search, selected count and scroll area. Search matches skill names and descriptions, or MCP server names, without changing hidden selections. Bot settings summarize inherited team limits by count; blocked resources remain searchable. The MCP registry, imports and bot/team selections have no fixed server-count cap.

### Evidence-based learning

`/learn` and background skill review save inactive candidates. **Bot settings → Skills & MCPs → Learning** shows the exact package diff, source evidence, task outcomes and version history. Define a motivating task and a distinct variation, then prepare baseline and candidate conversations against the same disposable workspace. Preparation does not run a model or grant tool access. Reset the environment between runs and use mock services for external effects; normal bot permissions still apply when you send the task.

The owner verifies source evidence, actual skill use and outcomes. Comparable real-model runs must pass the task checks and improve on a failing baseline before validation. A matching pinned trial is required before activation. Synthetic fixture results test this flow but never authorize activation or prove model quality. Intervening edits and reads from mutable installed skill packages invalidate the comparison. Rollback restores the previous package and enabled state; rejected lessons remain in the audit history.

### Azure Foundry

Open Settings → API keys → Azure Foundry. Choose Microsoft Entra ID or an Azure resource API key. Entra uses the existing Azure CLI login, or **Sign in with Microsoft** starts device-code sign-in. This requires Azure CLI on the server. Tenant and subscription can be selected explicitly. Tokens refresh on demand and stay on the server.

**Find my Azure resources** lists existing resources. Select a resource, refresh deployments, and choose the deployment names for chat, conversational Realtime, transcription, and TTS. Deployment discovery uses Azure management permissions; if those are unavailable, enter deployment names manually. No resource, deployment, role assignment, or subscription is created by setup.

Choose **Azure Foundry** in the Live call settings or voice engine settings. Chat, Live, and TTS share the Azure connection but use their own deployment names. Set **GPT-Live deployment** for native full-duplex calls through Azure's `/openai/v1/live` API. This takes priority over the alternative Realtime deployment and includes transcription. Alternatively, configure a conversational Realtime deployment and a transcription deployment. `gpt-realtime-whisper` and translation-only models cannot hold a Live conversation. TTS uses the Azure OpenAI-compatible audio speech endpoint.

References: [Azure Realtime WebRTC](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc), [Azure audio API](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview), [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli).

## Sidebar projects

Use **+ → New project** on desktop or **+ → Projects** on iPhone to group teams and individual bots under a collapsible divider. The editor has searchable, scrollable member lists and selected counts. Each item belongs to one project; selecting it in another project moves it there. Team members follow their team, while pinned bots keep their shortcuts.

Use the divider's pencil to rename it or change its members. Removing a project only ungroups its contents. Project membership and collapse state are saved in `copilotbot/projects.json` under the app data directory and synchronize across owner clients. Team renames preserve membership through stable team IDs. This layer is separate from the folders that organize a bot's conversation threads.

Implementation is isolated in the downstream `workspace-projects` modules, with sidebar, route and event hooks. Validate with `pnpm exec vitest run server/copilotbot/workspace-projects.test.ts server/copilotbot/workspace-projects.e2e.test.ts src/copilotbot/WorkspaceProjects.test.ts`, and the iOS `CopilotBotTests` / `testProjectGroupsPinnedBotAndTeamsAndCollapses` tests.

## Updating from upstream

Keep `upstream` pointing to `milind-soni/OpenMausBot` and `origin` pointing to this repository. Merge upstream history; do not rebase or squash the imported history.

```sh
git fetch upstream
git switch -c update/upstream-YYYY-MM-DD
git merge upstream/main
pnpm install --frozen-lockfile
pnpm typecheck
pnpm exec vitest run server/copilotbot
pnpm build
```

Downstream implementation lives in `server/copilotbot/`, `src/copilotbot/`, `shared/copilotbot.ts`, and this directory. Upstream files contain registry, config, credentials, UI-entry, and transport hooks. Keep provider logic in those downstream modules. The reusable chat runtime adds optional per-request headers and effort; existing providers retain their defaults. The Live controller adds an optional per-session socket factory; the existing OpenAI transport remains unchanged.

Check the hook files with `git diff upstream/main --stat`. Re-run the existing Live controller, credential storage, ACP authentication, and OpenAI chat regression suites when merging upstream changes to these areas. Run a separate read-only review and an isolated UI fixture before publishing. Tests use fake CLIs and fake audio; they do not prove a real microphone or access to a particular Azure deployment.

The upstream Apache-2.0 license and NOTICE remain in place. The separately licensed `enterprise/` directory is preserved as upstream source; this project does not change its license checks or grant rights to redistribute or operate enterprise features.

## Native iPhone companion

`ios/` restores the last public Apache-2.0 companion snapshot at upstream commit `900ec19a61ecc10b3d34a7af07c9bf6b2bb66ac0` (before the upstream mobile-source removal). Its unmodified import is preserved in commit `1637d688b`. Keep that mobile baseline distinct from later upstream desktop merges. Upstream's hosted subscription and enterprise services are not part of this fork's entitlement.

Generate the CopilotBot project from the unchanged upstream spec:

```sh
node ios/copilotbot-project.mjs
xcodegen generate --spec ios/.copilotbot-project.yml
open ios/OpenMausCompanion.xcodeproj
```

Select the `OpenMausCompanion` scheme. The generated app is **CopilotBot**, with bundle ID `com.copilotbot.app` and its own App Group/Keychain namespace. Choose your Apple development team for the app, Share extension and Widgets targets. Register the `group.com.copilotbot.shared` App Group. No signing identity, provisioning profile or provider key is committed. Device/TestFlight installation requires your signing setup; simulator builds can use `CODE_SIGNING_ALLOWED=NO` for offline previews.

```sh
swift test --package-path ios
xcodebuild -project ios/OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO build
```

On the phone: pair with the computer, then open **Settings → Provider sign-in** for Copilot or Azure Entra device-code login. The CLI must be installed on the computer. The bot's settings include model/effort, **Skills & MCPs**, **Team resources**, **Learning**, and YAML export. The new-bot button offers creation or YAML-file import, a settings review, and an explicit choice to enable imported schedules (off by default). Resource pickers use native scrolling lists, search, counts and persistent Save controls. Team limits continue to apply to current and future members.

The phone button starts native WebRTC live voice using the OpenAI or Azure provider configured on the computer. Self-hosted calls use the owner's provider account without the upstream hosted Pro plan. Provider fees still apply. Azure API keys and Entra credentials stay on the computer. Microphone permission, captions, mute, hang-up, interruption and idle cleanup remain native. Configure deployments on the computer; choose the Live provider in call settings. A simulator preview or successful signaling exchange does not prove microphone/audio quality on a physical phone.

Keep downstream views in `ios/App/CopilotBot/`, wire models in `ios/Sources/CompanionCore/CopilotBot.swift`, and project identity changes in `ios/copilotbot-project.mjs`. App/shared/client files contain narrow hooks. Companion route additions live in `companion/src/copilotbot/`; they do not expose general config writes, provider keys or MCP installation.

## Shared Open Brain workspace

The **Open Brain** item in the sidebar menu opens the selected conversation's workspace. Each private bot thread and team thread automatically receives its own Open Brain session, identified by a stable key containing the installation and thread IDs. CopilotBot projects are mirrored one for one in Open Brain. Existing and new threads follow their bot or team's current project; moving or renaming a project updates the existing sessions and their contents without replacing session IDs. Threads outside a project are standalone sessions. Empty obsolete integration-owned projects are archived; unrelated content is retained.

Project organization does not merge conversations or change memory ownership. Project recall searches related threads belonging to the same bot or team within the current project. Team captures carry `bot:` and stable `bot-id:` tags for every credited contributor, plus `kind:` and user-supplied topic tags.

Agents receive `brain_record`, `brain_task`, and `brain_recall` on every turn. The host binds those tools to the active conversation and actor. Failed writes remain in the local retry journal; the UI reports pending captures. Uploaded artifacts are copied locally before retry, and repeated delivery retains a stable capture identifier.

The web application and embedded workspace come from [Open Brain Lite](https://github.com/paguilar1227/open-brain-lite). Its `embedded.js` entry mounts the same React app directly in an isolated shadow root. CopilotBot proxies its API and files, retaining configured credentials server-side. The plugin downloads the current module whenever opened, so updating the connected Open Brain service updates its UI. There is no copied Open Brain UI in this repository.

Desktop packaging exports the runtime from the sibling `open-brain-lite` checkout, or `OPEN_BRAIN_SOURCE`. A healthy configured service is reused. Otherwise, the bundled upstream Docker Compose runtime starts locally; Docker must be installed and running. The extension's address and optional server token are editable in **App extensions**. Runtime logs and the pending journal live under the app data directory's `open-brain` folder.
