// Vite is the only frontend development and production pipeline.
// Tauri serves tauri-ui/dist directly and starts this dev server on port 1430.

import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const tauriUiDir = resolve(__dirname, 'tauri-ui');
const require = createRequire(import.meta.url);

// The desktop UI calls the proxy management API through relative /v1/local/*
// URLs. During development the page runs on the Vite origin, so the calls only
// work when the dev server forwards them to the plain-HTTP management port and
// injects the management token. Packaged builds use the Tauri native bridge
// instead and never take this path.
function devManagementProxy() {
  const { createDevManagementProxy } = require('./lib/dev/management-proxy.js');
  const middleware = createDevManagementProxy({
    repoRoot: __dirname,
    devPort: 1430,
    logger: {
      debug() {},
      warn(message, detail) {
        console.warn(`[dev-management-proxy] ${message}${detail ? ` ${detail}` : ''}`);
      },
    },
  });
  return {
    name: 'hpm-dev-management-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        middleware(req, res, next).catch((error) => {
          if (res.headersSent) {
            res.end();
            return;
          }
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(
            JSON.stringify({
              error: 'Dev management proxy failed: ' + String(error && error.message),
            })
          );
        });
      });
    },
  };
}

export default defineConfig({
  root: tauriUiDir,
  base: './',
  publicDir: false,
  clearScreen: false,
  plugins: [devManagementProxy()],
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
