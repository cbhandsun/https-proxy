// ESM entry point for the Tauri-UI Vite build.
//
// The legacy tauri-ui/app-*.js scripts are still loaded as plain
// <script defer> tags from tauri-ui/index.html, so this module's
// only job is to verify the Vite pipeline and to host the first
// incremental ESM migration. As new modules are added under
// tauri-ui/src/, they are imported here and their corresponding
// legacy <script> tag can be removed.

import { greet } from './utils.js';

const root = document.getElementById('vite-root');
if (root) {
  const stamp = new Date().toISOString();
  root.dataset.viteReady = stamp;
  console.info('[vite] ESM bundle ready at', stamp, greet('proxy'));
}
