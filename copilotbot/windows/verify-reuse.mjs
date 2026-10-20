import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

export function buildContract(workflow) {
  const job = workflow.jobs.build;
  const packageIndex = job.steps.findIndex(step => step.name === 'Package CopilotBot with independent plugin setup');
  assert.ok(packageIndex >= 0, 'Packaging step is missing');
  const steps = job.steps.slice(0, packageIndex + 1).map((step, index) => {
    const copy = structuredClone(step);
    if (index === packageIndex) delete copy.if;
    return copy;
  });
  return { env: workflow.env, defaults: workflow.defaults, runsOn: job['runs-on'], jobEnv: job.env, jobDefaults: job.defaults, steps };
}

export function verifyReuse(source) {
  assert.match(source, /^[a-f0-9]{40}$/i, 'Expected an exact installer source commit');
  const changed = execFileSync('git', ['diff', '--name-only', source, 'HEAD'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const allowed = new Set(['copilotbot/windows/verify-update.mjs', 'copilotbot/windows/verify-reuse.mjs', 'scripts/testing/copilotbot-update-reuse.test.mjs', '.github/workflows/copilotbot-windows.yml', 'copilotbot/README.md']);
  assert.deepEqual(changed.filter(file => !allowed.has(file)), [], 'Production source differs from the installer');
  const workflowPath = '.github/workflows/copilotbot-windows.yml';
  const before = parse(execFileSync('git', ['show', `${source}:${workflowPath}`], { encoding: 'utf8' }));
  const after = parse(readFileSync(workflowPath, 'utf8'));
  assert.deepEqual(buildContract(after), buildContract(before), 'Build commands or environment differ from the installer');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) verifyReuse(process.argv[2]);
