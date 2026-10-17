import type { NewBotDefaults } from './new-bot-defaults.ts';

export interface TemplateSource { filename: string; yaml: string }
export interface TemplateDiagnostic { path: string; message: string; line?: number; column?: number }
export interface BotTemplatePreview {
  id: string;
  filename: string;
  document: number;
  defaults?: NewBotDefaults;
  diagnostics: TemplateDiagnostic[];
  warnings: string[];
}
export interface TemplateImportEntry {
  filename: string;
  defaults: NewBotDefaults;
  state: 'ready' | 'importing' | 'created' | 'failed';
  botId?: string;
  error?: string;
  warnings?: string[];
}
export interface TemplateImportRequest {
  botId: string;
  threadId: string;
  entries: TemplateImportEntry[];
  result?: 'applied' | 'partial' | 'failed' | 'denied';
  resumed?: boolean;
}
