// Vite config for the Tauri-UI frontend.
//
// The Tauri shell serves the frontendDist directory as a static site, so this
// config keeps the existing tauri-ui/ structure intact and adds a build pipeline
// for ESM modules under tauri-ui/src/.
//
// Current scope:
//   - Bundles tauri-ui/src/main.js (and any ESM it imports) into
//     tauri-ui/dist/ as a single hashed chunk.
//   - The five legacy tauri-ui/app-*.js scripts remain as side-effect
//     bundle entries so the existing global-scope conventions keep working
//     while we incrementally migrate them to ESM.
//   - The dev server (port 1430) matches the Tauri devUrl in
//     src-tauri/tauri.conf.json.
//
// Future work: migrate app-bridge.js, app-audit.js, app-cli.js,
// app-diagnostics.js, and app.js to ESM modules under tauri-ui/src/.

import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const tauriUiDir = resolve(__dirname, 'tauri-ui');

export default defineConfig({
  root: tauriUiDir,
  // tauri-ui/ contains the canonical sources; do not auto-copy a sibling
  // public/ tree. Set this to a string path if you later want one.
  publicDir: false,
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    minify: 'esbuild',
    cssCodeSplit: true,
  },
  esbuild: {
    target: 'es2022',
    legalComments: 'none',
  },
  optimizeDeps: {
    include: [],
  },
});
