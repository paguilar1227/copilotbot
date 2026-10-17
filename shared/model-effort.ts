import type { EffortLevel } from './wire.ts';

/** A provider may advertise a smaller effort set for a particular model.
 * Opaque model variants remain a separate control on engines which use them. */
export function modelEffortLevels(instance: {
  capabilities?: { effortLevels?: readonly EffortLevel[]; modelVariants?: boolean };
  models: { default: string; options: ReadonlyArray<{ id: string; variants?: ReadonlyArray<{ id: string }> }> };
} | undefined, model: string): readonly EffortLevel[] {
  const levels = instance?.capabilities?.effortLevels ?? [];
  if (!instance || instance.capabilities?.modelVariants) return levels;
  const choice = instance.models.options.find(option => option.id === model);
  return choice?.variants === undefined ? levels : levels.filter(level => choice.variants!.some(variant => variant.id === level));
}
