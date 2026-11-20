/**
 * Runs the শাখা registry smoke test with esbuild.
 *
 * Mirrors `run.mjs`: the app imports `firebase/*`, so those are aliased to the
 * in-memory stubs in this folder before the hook is rendered server-side.
 */
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const stub = (file) => path.join(here, file).replaceAll('\\', '/');

// The bundle lives inside the project so `react` / `react-dom` (kept external,
// they are CommonJS) resolve from the repository's own node_modules.
const outdir = path.join(here, '.tmp-sections');
const outfile = path.join(outdir, 'sectionRegistry.mjs');

try {
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints: [path.join(here, 'sectionRegistry.smoke.mjs')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    logLevel: 'warning',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server'],
    plugins: [{
      name: 'firebase-stubs',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^firebase\/app$/ }, () => ({ path: stub('fakeFirebaseApp.mjs') }));
        buildApi.onResolve({ filter: /^firebase\/auth$/ }, () => ({ path: stub('fakeFirebaseAuth.mjs') }));
        buildApi.onResolve({ filter: /^firebase\/database$/ }, () => ({ path: stub('fakeFirebaseDatabase.mjs') }));
      },
    }],
  });
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(outdir, { recursive: true, force: true });
}
