import type { WireBot } from "./wire.ts";
import type { RoutineInput } from "./routines.ts";
import type { ToolScope } from "./tool-scope.ts";
import type { TemplateAvatar } from './template-avatar.ts';

/** Data shared by the default template and an individual creation draft. */
export type BotDefaultsProfile = Partial<Pick<WireBot,
  "name" | "title" | "description" | "soul" | "notifications" | "avatarUrl" | "avatarCrop" |
  "mascotBody" | "color" | "voice" | "speakReplies" | "section" | "modelSelection" |
  "cloudBackend" | "autoStartVps" | "approvalMode" | "alwaysAllow" | "chiefOfStaff" |
  "managedSections" | "approvePeerComms" | "composio" | "browser" | "replyStyle" |
  "voiceNotes" | "memoryEnabled" | "memoryUpkeep" | "recordBrowserSteps" |
  "avatarZoom" | "avatarFocusX" | "avatarFocusY"
>> & {
  mascotExpression?: string | null;
  computer?: WireBot["computer"] | null;
  cwd?: string | null;
  peers?: string[] | null;
  browserProfile?: string | null;
  mcpServers?: string[] | null;
  skillAccess?: string[] | null;
  toolScope?: ToolScope | null;
  parkDirectMessages?: boolean;
  helperModel?: boolean;
  cacheKeepWarm?: boolean | null;
};

export type BotRoutineTemplate = Omit<RoutineInput, "botId" | "target" | "groupId" | "resultsThreadId">;
export interface BotSkillTemplate {
  name: string;
  description: string;
  source: string;
  text: string;
  enabled: boolean;
  warnings: string[];
}
export interface NewBotDefaults {
  avatar?: TemplateAvatar;
  profile: BotDefaultsProfile;
  memory: Record<string, string>;
  skills: BotSkillTemplate[];
  routines: BotRoutineTemplate[];
  librarySkills?: string[];
}
