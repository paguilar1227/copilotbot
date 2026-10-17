import { expect, it } from 'vitest';
import { modelEffortLevels } from './model-effort.ts';
it('restricts model efforts without changing opaque model variants', () => {
  const instance = { capabilities: { effortLevels: ['low', 'high'] as const }, models: { default: 'reasoning', options: [{ id: 'reasoning', variants: [{ id: 'high' }] }, { id: 'fast', variants: [] }] } };
  expect(modelEffortLevels(instance, 'reasoning')).toEqual(['high']);
  expect(modelEffortLevels(instance, 'fast')).toEqual([]);
  expect(modelEffortLevels({ ...instance, capabilities: { ...instance.capabilities, modelVariants: true } }, 'fast')).toEqual(['low', 'high']);
});
