# CopilotBot

Private downstream of [OpenMausBot](https://github.com/milind-soni/OpenMausBot), based on upstream commit `113ec83256971c62088a0bbd507c6fa3a2cd4091`.

## Set up

Install dependencies with `pnpm install --frozen-lockfile`. Node 24 or newer is required by upstream.

For development, run `node copilotbot/dev.mjs` and `pnpm dev` in separate terminals. The development server uses `~/.copilotbot`, independently of OpenMausBot. Set `OMB_DATA_DIR` explicitly to use another directory.

Build the macOS app with `node copilotbot/package.mjs`. It produces `release-copilotbot/mac-arm64/CopilotBot.app`. The app has its own bundle identifier, Keychain identity, and `~/.copilotbot` data directory. Upstream auto-updates are disabled for CopilotBot so they cannot overwrite downstream features. The source package metadata remains upstream-owned; the downstream packaging script supplies the branding.

For a local build, `node copilotbot/package.mjs --reuse-resources /Applications/OpenMausBot.app/Contents/Resources` reuses the installed upstream native runtimes while rebuilding the UI, server, companion, and Electron code. The installed app is read only. This optional shortcut targets macOS arm64. A distributable build needs a signing identity and notarization configured by its owner.

### GitHub Copilot

Open Settings → Engines → GitHub Copilot. If the CLI is missing, the setup card explains how to install it or select its path. **Set up Copilot** runs `copilot login --device-code`, shows the one-time code, and opens GitHub. The native CLI owns its credential. No token is copied into the app.

The model catalog comes from ACP. Models and reasoning effort use separate controls. Unsupported effort is rejected before a prompt is sent. The CLI must support ACP and `login --device-code`.

### Azure Foundry

Open Settings → API keys → Azure Foundry. Choose Microsoft Entra ID or an Azure resource API key. Entra uses the existing Azure CLI login, or **Sign in with Microsoft** starts device-code sign-in. This requires Azure CLI on the server. Tenant and subscription can be selected explicitly. Tokens refresh on demand and stay on the server.

**Find my Azure resources** lists existing resources. Select a resource, refresh deployments, and choose the deployment names for chat, conversational Realtime, transcription, and TTS. Deployment discovery uses Azure management permissions; if those are unavailable, enter deployment names manually. No resource, deployment, role assignment, or subscription is created by setup.

Choose **Azure Foundry** in the Live call settings or voice engine settings. Chat, Live, and TTS share the Azure connection but use their own deployment names. Live requires a conversational Realtime deployment; `gpt-realtime-whisper` and translation-only models cannot serve that role. TTS uses the Azure OpenAI-compatible audio speech endpoint.

References: [Azure Realtime WebRTC](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc), [Azure audio API](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview), [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli).

## Updating from upstream

Keep `upstream` pointing to `milind-soni/OpenMausBot` and `origin` pointing to this private repository. Merge upstream history; do not rebase or squash the imported history.

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
