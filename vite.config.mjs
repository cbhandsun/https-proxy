// Vite is the only frontend development and production pipeline.
// Tauri serves tauri-ui/dist directly and starts this dev server on port 1430.

import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const tauriUiDir = resolve(__dirname, 'tauri-ui');

export default defineConfig({
  root: tauriUiDir,
  base: './',
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
    sourcemap: false,
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
