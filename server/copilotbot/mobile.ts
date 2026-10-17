import { z } from 'zod';
import type { AppConfig } from '../config.ts';

/** Local, user-funded calls are a feature of this fork. Hosted service
 * entitlements are still evaluated by the upstream plan implementation. */
export function selfHostedLiveAllowed(config: AppConfig, hosted: boolean): boolean {
  if (hosted) return false;
  if (config.live?.provider === 'azure') {
    return Boolean(config.azure?.endpoint && (config.azure.liveDeployment || config.azure.realtimeDeployment));
  }
  return Boolean(config.live?.key?.trim());
}


export function mobileVoicePatch(value: unknown) {
  const body = z.object({ provider: z.enum(["elevenlabs", "fish", "system", "chatterbox", "azure"]) }).strict().parse(value);
  return { tts: body };
}
