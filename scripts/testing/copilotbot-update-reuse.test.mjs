import { expect, it } from 'vitest';
import { buildContract } from '../../copilotbot/windows/verify-reuse.mjs';

const workflow = () => ({ env: { BUILD_FLAVOR: 'release' }, jobs: { build: { 'runs-on': 'windows-latest', steps: [{ uses: 'node-setup@pinned', with: { version: 24 } }, { name: 'Package CopilotBot with independent plugin setup', run: 'node copilotbot/package.mjs --win' }, { run: 'verify-install' }] } } });

it('allows verification changes after packaging but only the reuse condition on packaging', () => {
  const before = workflow();
  const after = structuredClone(before);
  after.jobs.build.steps[1].if = "inputs.installer_run_id == ''";
  after.jobs.build.steps[2].run = 'new-verification';
  expect(buildContract(after)).toEqual(buildContract(before));
});

it.each(['commands', 'tools', 'environment', 'runner'])('rejects changed %s when reusing a binary', kind => {
  const before = workflow();
  const after = structuredClone(before);
  if (kind === 'commands') after.jobs.build.steps[1].run = 'node different-package.mjs';
  if (kind === 'tools') after.jobs.build.steps[0].with.version = 26;
  if (kind === 'environment') after.env.BUILD_FLAVOR = 'other';
  if (kind === 'runner') after.jobs.build['runs-on'] = 'ubuntu-latest';
  expect(buildContract(after)).not.toEqual(buildContract(before));
});
