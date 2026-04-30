// Build scripts/smoke-impl.ts to a temp file via esbuild, then dynamically import it.
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

mkdirSync('node_modules/.cache/smoke', { recursive: true });
const outFile = resolve('node_modules/.cache/smoke/smoke-impl.mjs');

await build({
  entryPoints: ['scripts/smoke-impl.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: outFile,
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});

const mod = await import(pathToFileURL(outFile).href);
await mod.run('fixtures/sample-ari.xlsx');
