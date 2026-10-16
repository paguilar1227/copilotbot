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

New bot → **Import YAML file** loads a reviewable draft. Nothing runs until **Create bot**. Bot settings → **Identity → Export YAML template** saves version 1 of `copilotbot/bot`, including model/effort, persona, permission preferences, voice, routines and resource selections. Credentials, grants, conversation history, learned memory, attached files and avatar images are excluded. Review free-text instructions before sharing them.

**Skills & MCPs** appears in bot settings and team settings. Choose all available resources, selected names, or none. Team choices limit every member, including future members; individual choices can narrow them further. Changes wait until affected bots are idle. A selected skill must also be installed, assigned and enabled. Imported templates report missing or disabled resources; they never install servers or transfer sign-ins. Skill references use the local shared library; private skills must be added to the new bot separately.

These choices control the app's skill index, managed native skill links, skill tools and configured MCP mounts. They are not a filesystem sandbox or a replacement for a CLI's independently configured plugins. Team policies are stored separately from upstream settings, using stable team identifiers that survive renames.

### Evidence-based learning

`/learn` and background skill review save inactive candidates. **Bot settings → Skills & MCPs → Learning** shows the exact package diff, source evidence, task outcomes and version history. Define a motivating task and a distinct variation, then prepare baseline and candidate conversations against the same disposable workspace. Preparation does not run a model or grant tool access. Reset the environment between runs and use mock services for external effects; normal bot permissions still apply when you send the task.

The owner verifies source evidence, actual skill use and outcomes. Comparable real-model runs must pass the task checks and improve on a failing baseline before validation. A matching pinned trial is required before activation. Synthetic fixture results test this flow but never authorize activation or prove model quality. Intervening edits and reads from mutable installed skill packages invalidate the comparison. Rollback restores the previous package and enabled state; rejected lessons remain in the audit history.

### Azure Foundry

Open Settings → API keys → Azure Foundry. Choose Microsoft Entra ID or an Azure resource API key. Entra uses the existing Azure CLI login, or **Sign in with Microsoft** starts device-code sign-in. This requires Azure CLI on the server. Tenant and subscription can be selected explicitly. Tokens refresh on demand and stay on the server.

**Find my Azure resources** lists existing resources. Select a resource, refresh deployments, and choose the deployment names for chat, conversational Realtime, transcription, and TTS. Deployment discovery uses Azure management permissions; if those are unavailable, enter deployment names manually. No resource, deployment, role assignment, or subscription is created by setup.

Choose **Azure Foundry** in the Live call settings or voice engine settings. Chat, Live, and TTS share the Azure connection but use their own deployment names. Set **GPT-Live deployment** for native full-duplex calls through Azure's `/openai/v1/live` API. This takes priority over the alternative Realtime deployment and includes transcription. Alternatively, configure a conversational Realtime deployment and a transcription deployment. `gpt-realtime-whisper` and translation-only models cannot hold a Live conversation. TTS uses the Azure OpenAI-compatible audio speech endpoint.

References: [Azure Realtime WebRTC](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc), [Azure audio API](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview), [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli).

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
