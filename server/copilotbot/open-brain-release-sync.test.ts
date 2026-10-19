import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateOpenBrainPin } from '../../scripts/sync-open-brain-release.ts';
it('advances the pinned source and installer version once for a newer stable release', () => {
  const root = mkdtempSync(join(tmpdir(), 'brain-sync-')); mkdirSync(join(root, 'copilotbot'));
  const pin = join(root, 'copilotbot/open-brain-version.json'), version = join(root, 'copilotbot/version.json');
  writeFileSync(pin, JSON.stringify({ version: '0.1.0', revision: '0'.repeat(40) }));
  writeFileSync(version, JSON.stringify({ version: '0.1.112-copilotbot.13' }));
  const release = { schemaVersion: 1 as const, apiVersion: 1 as const, version: '0.1.1', revision: '1'.repeat(40), archive: 'open-brain-runtime.tar.gz' as const, bytes: 123, sha256: 'a'.repeat(64), url: 'https://example.com/release' };
  expect(updateOpenBrainPin(root, release)).toBe(true);
  expect(JSON.parse(readFileSync(pin, 'utf8')).revision).toBe(release.revision);
  expect(JSON.parse(readFileSync(version, 'utf8')).version).toBe('0.1.112-copilotbot.14');
  expect(updateOpenBrainPin(root, release)).toBe(false);
  expect(updateOpenBrainPin(root, { ...release, version: '0.0.9', revision: '2'.repeat(40) })).toBe(false);
});
