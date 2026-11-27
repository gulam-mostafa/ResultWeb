import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vite config for the BROWSER RENDER CHECK only (`scripts/browser/render-check.mjs`).
 *
 * Two pages are built into `dist-render-check`:
 *  - `index.html`        → the real app (all pages, real Firebase SDK);
 *  - `modal-check.html`  → a focused harness that mounts ONLY the annual promotion
 *    modal with a controlled promotion log (`scripts/browser/modalEntry.jsx`).
 *
 * `appType: 'mpa'` keeps `vite preview` from rewriting the harness URL to the app
 * (a single-page fallback made `/modal-check.html` serve the dashboard).
 *
 * The check loads the app with every `firebaseio.com` / `firebaseapp.com` request
 * BLOCKED (see `render-check.mjs`), so it renders from the seeded local cache and
 * can never read or write live data.
 */
export default defineConfig({
  plugins: [react()],
  appType: 'mpa',
  build: {
    outDir: 'dist-render-check',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: path.join(process.cwd(), 'index.html'),
        modal: path.join(process.cwd(), 'modal-check.html'),
      },
    },
  },
  preview: { port: 4178, strictPort: true, host: '127.0.0.1' },
});
