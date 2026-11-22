/**
 * Runs the smoke tests with esbuild.
 *
 * The app imports `firebase/app` and `firebase/database`; both are aliased to the
 * in-memory stubs in this folder so the writer can be exercised without a network.
 */
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const stub = (file) => path.join(here, file).replaceAll('\\', '/');

/** Smoke entry points run in order; each keeps its own assertions. */
const ENTRIES = ['promotion.smoke.mjs', 'rolls.smoke.mjs', 'render.smoke.mjs'];

// The bundle must live INSIDE the project so `react` / `react-dom` resolve from the
// workspace `node_modules` when Node imports the (externalised) modules.
const outdir = await mkdtemp(path.join(here, '.build-'));
try {
  for (const entry of ENTRIES) {
    const outfile = path.join(outdir, entry.replace(/\.mjs$/, '.bundle.mjs'));
    await build({
      entryPoints: [path.join(here, entry)],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node18',
      jsx: 'automatic',
      loader: { '.jsx': 'jsx' },
      // `react`, `react-dom` and `lucide-react` ship CommonJS builds; this shim lets
      // the bundled ESM call their internal `require` (stream, etc.) at runtime.
      banner: {
        js: "import{createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);",
      },
      logLevel: 'warning',
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
  }
} finally {
  await rm(outdir, { recursive: true, force: true });
}
