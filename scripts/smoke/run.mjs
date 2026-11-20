/**
 * Runs the promotion smoke test with esbuild.
 *
 * The app imports `firebase/app` and `firebase/database`; both are aliased to the
 * in-memory stubs in this folder so the writer can be exercised without a network.
 */
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const stub = (file) => path.join(here, file).replaceAll('\\', '/');

const outdir = await mkdtemp(path.join(tmpdir(), 'resultweb-smoke-'));
const outfile = path.join(outdir, 'promotion.mjs');

try {
  await build({
    entryPoints: [path.join(here, 'promotion.smoke.mjs')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
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
} finally {
  await rm(outdir, { recursive: true, force: true });
}
