import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic.ts';
import type { Store } from '../store.ts';
import type { AppConfig } from '../config.ts';
import { azureSettings } from '../../shared/copilotbot.ts';
import { describeDecider } from '../decider/index.ts';
import { botTemplateSchema } from './bot-templates.ts';
import { Roster } from './roster.ts';

export const SETUP_ASSISTANT_TEMPLATE = botTemplateSchema.parse({
  format: 'copilotbot/bot', version: 1,
  profile: {
    name: 'CopilotBot Guide', title: 'Setup and app help', color: 'blue', mascotExpression: 'happy',
    description: 'Your setup concierge for Copilot, Azure Foundry, voice, Open Brain and everyday app help.',
    approvalMode: 'ask', memoryEnabled: true,
    soul: `You are CopilotBot Guide, the user's patient setup concierge and ongoing product support assistant.
Your goal is a working setup, not a list of instructions the user must figure out alone. On first contact, call get_copilotbot_guide (use find_tool if it is not listed) and read overview plus the relevant topic. Read it again when troubleshooting; its status comes from the running app. Use its exact setting names. Do not invent a setting or claim a connection works from configuration alone.
Start by understanding what the user wants to use and what is already connected. Keep a short checklist, explain the next useful step, perform authorized checks and fixes, and wait at human sign-in/consent steps. If no model is connected, the greeting explains how to connect Copilot before you can reply. Reuse existing accounts, resources and deployments before offering to create anything.
For Copilot: use Settings → AI → Model providers → GitHub Copilot → Set up Copilot for device-code sign-in. Never ask for a GitHub password, token or device code in chat. Check missing CLI, subscription access, expired login, and model discovery. Verify with a short real reply after sign-in.
For Azure: use Settings → AI → API keys → Azure Foundry. Prefer Microsoft Entra ID and its Sign in with Microsoft flow; use the API-key field only when the user chooses that mode. Never print keys, access tokens, or credential files. Discover the user's tenant/subscription/resource and deployed model names. Check Azure CLI availability, RBAC/data-plane permission, endpoint, quota, region and deployment readiness. An Azure role at the wrong scope or a completed login alone does not prove inference access.
Before creating Azure resources, deploying models, changing IAM, enabling paid usage or increasing quota/capacity, show the selected subscription, region, proposed resources and current cost estimate and get the user's approval. Never hard-code a subscription, region, model version or deployment capacity. Use current Microsoft documentation and the subscription's catalog. Save a deployment name, not an assumed model ID. Do not deploy or test a model the user did not authorize.
Set up Live and TTS separately. A chat model is not a speech endpoint, and transcription alone is not a Live conversation. GPT-Live includes transcription; the alternative conversational Realtime path needs its configured transcription deployment. Test microphone permission/input, spoken output, interruption and a fresh conversational response, not just a transcript. TTS needs its own speech deployment and a short audible sample with the user's consent.
For fast decisions, the app can use an Azure OpenAI chat deployment with strict JSON output via Settings → AI → Decision model → Azure Foundry. This is a classifier for Auto team routing, not a claim that Jev itself is on Azure. Reuse the Azure connection, select a compatible low-latency deployment, run Test and report latency. General chat probabilities are model estimates, not Jev calibration. Keep lead fallback enabled; do not promise routing for coming-soon features.
Know the rest of the app too: model/effort pickers, individual and team threads, projects, skills/MCP access and inherited limits, the saved roster and YAML import/export, Open Brain sessions and project sync, artifacts/tasks/notes/timeline, extensions and independent plugin update/backup/rollback, permissions, routines, phones, credentials, diagnostics and updates. Read the corresponding guide topic rather than guessing. Use built-in proposal tools for changes when available; otherwise guide or operate the actual settings UI with user permission. Do not edit encrypted credentials or bypass approval gates.
Anticipate what the user needs to remember: when Open Brain is available, save setup progress, verified choices, consequential errors/decisions, follow-up tasks and relevant artifacts there. Include session and bot attribution. Record facts only after observing them, distinguish configured from verified, and never store secrets. End each setup step with what worked, what remains, and one clear next action. Remain available for everyday app questions after setup is complete.`,
  },
  skills: [], resources: { skills: null, mcpServers: null }, routines: [],
});

export const SETUP_GREETING = `I'm CopilotBot Guide. I'll help connect Copilot, configure Azure models for Live voice and text-to-speech, and explain how to use the app.

**First, connect an AI provider:** open **Settings → AI → Model providers → GitHub Copilot → Set up Copilot** and complete GitHub's device-code sign-in. If Copilot CLI is missing, that screen explains how to install it. I can reply once a provider is connected.

Then tell me “Check my setup.” We'll work through missing dependencies and permissions together, reuse Azure resources you already have, and verify each connection. You approve any paid deployments or access changes. You can also ask me about projects, teams, templates, skills, MCPs, Open Brain, or any setting.`;

export function installSetupAssistant(store: Store, dataDir: string) {
  const directory = join(dataDir, 'copilotbot');
  const marker = join(directory, 'setup-assistant-installed.json');
  if (existsSync(marker)) return;
  const roster = new Roster(join(directory, 'roster.json'));
  let botId: string | undefined;
  if (store.needsSeed()) {
    const { name, title, description, soul, color, mascotExpression } = SETUP_ASSISTANT_TEMPLATE.profile;
    const bot = store.createBot({ name, title, description, soul, color, mascotExpression }, { seedMessages: false });
    store.patchBot(bot.id, { approvalMode: 'ask', memoryEnabled: true });
    store.appendMessage(bot.threadId, { role: 'bot', kind: 'text', text: SETUP_GREETING });
    botId = bot.id;
  }
  const existing = roster.read().bots.find(entry => entry.template.profile.name === SETUP_ASSISTANT_TEMPLATE.profile.name);
  const template = existing ?? roster.saveBot(SETUP_ASSISTANT_TEMPLATE, undefined, undefined, botId);
  mkdirSync(directory, { recursive: true });
  writeFileAtomic(marker, JSON.stringify({ templateId: template.id, botId }), { mode: 0o600 });
}

export const SETUP_TOPICS = {
  overview: 'Start with Copilot sign-in. Then connect Azure Foundry, select Live/TTS deployments, optionally choose an Azure decision model, install Open Brain, and verify a real task. Open Settings from the user menu at the bottom of the sidebar. Check each service only after the user chooses it; no paid provisioning or usage is implicit. This guide is shipped with the running app. The connection statuses below are configuration/inventory facts, not proof of successful inference.',
  copilot: 'Settings → AI → Model providers → GitHub Copilot → Set up Copilot starts device-code login. Missing CLI instructions appear there. The Windows installer bundles Copilot CLI; other platforms can install from https://docs.github.com/en/copilot/how-tos/copilot-cli/install-copilot-cli . Reuse normal CLI sign-in. After login refresh the engine/model catalog, choose a model and supported effort, and verify a short message. A Copilot subscription does not provide Azure/OpenAI API credits. If a new install has no engine, use these controls before trying to chat with Guide.',
  azure: 'Settings → AI → API keys → Azure Foundry holds one connection reused by chat, Live, TTS and Azure decisions. Microsoft Entra ID uses Azure CLI on the machine running CopilotBot and Sign in with Microsoft. API-key mode uses the secure key field. Enter the resource HTTPS endpoint, tenant/subscription if needed, and use Find my Azure resources / Refresh deployments. Confirm Cognitive Services OpenAI User (or equivalent data-plane permission) at the selected resource, and appropriate management permission for discovery. Discover supported models, versions, regions, quota and prices from the current Azure catalog; do not invent defaults. Deployment creation and IAM changes need explicit consent. Official docs: https://learn.microsoft.com/azure/ai-foundry/openai/how-to/managed-identity and https://learn.microsoft.com/azure/ai-foundry/openai/concepts/models .',
  voice: 'Settings → AI → API keys → Azure Foundry: set GPT-Live deployment, or Alternative Realtime deployment plus Realtime transcription deployment; set Text-to-speech deployment separately. Then select Azure Foundry in Live-call and voice settings. GPT-Live has built-in transcription; a transcription-only model cannot conduct a Live call. Common TTS example: gpt-4o-mini-tts, if offered in the selected resource. Check the current model catalog; deployment labels can be anything. Live input is audio to the voice model, while work delegated to the bot may be text. Check the host microphone (including remote audio forwarding), OS/app mic permission, input meter, speaker, interruptions, and a fresh spoken reply. Test TTS with an audible short sample only after consent. Docs: https://learn.microsoft.com/azure/ai-foundry/openai/how-to/realtime-audio and https://learn.microsoft.com/azure/ai-foundry/openai/text-to-speech-quickstart .',
  decisions: 'Settings → AI → Decision model → Azure Foundry uses the same Azure endpoint/auth as chat and voice. Select a chat deployment with strict JSON-schema output; gpt-4.1-mini is one documented example, subject to current availability. Run Test and then enable fast decisions / room routing. These decisions choose who answers unmentioned messages in Auto rooms, not general task execution. Explicit mentions win. Failed, slow, malformed or uncertain answers fall back to the room lead within the existing routing budget. Chat-model probabilities are estimates; Jev itself is a separate TypeSafe service. Browser-click and tool-selection decisions are not implemented. Docs: https://learn.microsoft.com/azure/ai-foundry/openai/how-to/structured-outputs .',
  organization: 'The sidebar contains individual bots, teams and collapsible projects. Bot/team threads have separate conversation context. Moving a bot or team between projects moves its existing Open Brain sessions, preserving notes/tasks/artifacts. Shared bot memory/learned skills may be reused across its threads; do not promise per-team memory isolation for one bot without checking its scope. Model and effort controls are in the conversation model picker and bot settings.',
  resources: 'Open a bot profile or team settings for skills and MCP access. Search and selected counts work with large catalogs. Team selections are inherited limits, including for bots added later; an individual bot cannot widen them. Copilot-native .copilot skills/MCPs are surfaced alongside app-managed entries. Add and review a dependency before enabling it. Permissions remain controlled by the user; new templates start at Ask.',
  templates: 'New or share opens creation/import and the saved roster. Save a deployed bot or team as a template; templates can remain undeployed, be edited/exported as YAML, imported in batches, then deployed. Malformed/missing fields show diagnostics before import. A bot template used by a team template cannot be deleted until that team definition is changed. Avatars travel with templates. Bots can request imports with import_bot_templates; the user reviews the import card.',
  memory: 'Open Brain is installed from its own releases in Extensions / the Open Brain setup view, not tied to a CopilotBot release. The Open Brain entry opens the shared interface. Every bot/team thread maps to a session; projects mirror the bot/team structure. Save relevant plans, documents/artifacts, decisions, findings, user-facing notes and actionable tasks proactively with session/bot tags. Use the timeline to help humans resume work. Per-bot Skills contains learning candidates and review/rollback history; learned skills are not automatically proof of improvement.',
  maintenance: 'Extensions manages plugins. Open Brain has Install, Check for updates, Update and rollback with backups; diagnose missing Docker/WSL/runtime there. App updates and Open Brain updates are independent. Never erase user data or a backup to fix an update. Credentials stay in the local OS credential store; the user handles OS keychain prompts. Use routines for explicitly requested schedules. Pair the phone with this host; live microphone forwarding and phone signing/distribution are separate from desktop model setup.',
  troubleshooting: 'Read current status before changing settings. Missing Copilot: install/recheck CLI. Signed out: device sign-in. Empty models: refresh after authentication. Missing Azure CLI: install from https://learn.microsoft.com/cli/azure/install-azure-cli on the bot host. Azure 401/403: verify selected tenant/subscription and data-plane RBAC; 404: resource endpoint and deployment name; 429: capacity/quota/rate limits, not another password. A successful discovery is not an inference test. Voice: distinguish a transcription model from a conversational deployment and verify host audio devices/permissions. Open Brain: inspect setup status, Docker and retained backups before repair. Preserve user work and report exact observable failures without printing secrets.',
} as const;

export function setupGuide(topic: string, cfg: AppConfig, engines: Array<{ instanceId: string; driverKind: string; state: string; authenticated?: boolean }>) {
  if (!Object.hasOwn(SETUP_TOPICS, topic)) throw new Error(`Unknown topic. Choose ${Object.keys(SETUP_TOPICS).join(', ')}.`);
  return { topic, guide: SETUP_TOPICS[topic as keyof typeof SETUP_TOPICS], topics: Object.keys(SETUP_TOPICS),
    status: { engines, azure: azureSettings(cfg.azure), decisions: describeDecider(cfg),
      liveProvider: cfg.live?.provider, ttsProvider: cfg.tts?.provider },
  };
}
