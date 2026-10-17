import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { reusedDuckdbResource } from '../copilotbot/package-resources.mjs';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const { getFileMatchers, copyFiles } = builderRequire('app-builder-lib/out/fileMatcher.js');

it('copies reused native packages through the actual electron-builder resource filter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'copilotbot-reused-resources-'));
  const source = join(root, 'installed-resources'), destination = join(root, 'packaged-resources');
  const files = ['@duckdb/node-api/lib/index.js', '@duckdb/node-bindings/duckdb.js', '@duckdb/node-bindings-darwin-arm64/duckdb.node', '@resvg/resvg-js/index.js', '@1password/sdk-core/nodejs/core_bg.wasm'];
  try {
    for (const name of files) {
      const file = join(source, 'duckdb/node_modules', name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `fixture: ${name}`);
    }
    const matchers = getFileMatchers({ extraResources: [reusedDuckdbResource(source)] }, 'extraResources', destination, {
      defaultSrc: root, macroExpander: value => value, customBuildOptions: {}, globalOutDir: destination,
    });
    await copyFiles(matchers);
    for (const name of files) expect(readFileSync(join(destination, 'duckdb/node_modules', name), 'utf8')).toBe(`fixture: ${name}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
