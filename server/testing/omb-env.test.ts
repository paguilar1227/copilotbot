import { expect, it } from 'vitest';
import { childEnv } from './omb-env.ts';
it('keeps automatic Open Brain off unless the isolated fixture explicitly enables it', () => {
  expect(childEnv().OMB_OPEN_BRAIN_ENABLED).toBe('0');
  expect(childEnv({ OMB_OPEN_BRAIN_ENABLED: '1' }).OMB_OPEN_BRAIN_ENABLED).toBe('1');
});
