'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const html = read('tauri-ui/index.html');
const main = read('tauri-ui/src/main.js');
const viteConfig = read('vite.config.mjs');
const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
const packageJson = JSON.parse(read('package.json'));

assert.match(html, /<script\s+type="module"\s+src="\/src\/main\.js"><\/script>/);
assert.doesNotMatch(html, /<script[^>]+app(?:-[^"]+)?\.js/);
assert.doesNotMatch(html, /cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com/);
assert.match(main, /import '\.\/styles\/app\.css';/);
assert.match(main, /import '\.\/modules\/app-ux\.js';/);
assert.match(main, /import '\.\/modules\/app\.js';/);
assert.match(viteConfig, /base:\s*'\.\/'/);
assert.match(viteConfig, /sourcemap:\s*false/);
assert.equal(fs.existsSync(path.join(repoRoot, 'tauri-ui/src/styles/app.css')), true);
for (const moduleName of [
  'app-ux.js',
  'app-bridge.js',
  'app-audit.js',
  'app-cli.js',
  'app-diagnostics.js',
  'app-tool-status.js',
  'app-environment.js',
  'app-mcp.js',
  'app.js',
]) {
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'tauri-ui', 'src', 'modules', moduleName)),
    true,
    `${moduleName} must live under tauri-ui/src/modules`
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'tauri-ui', moduleName)),
    false,
    `${moduleName} must not return to the tauri-ui root`
  );
}

assert.equal(tauriConfig.build.frontendDist, '../tauri-ui/dist');
assert.match(tauriConfig.build.beforeDevCommand, /frontend:dev/);
assert.match(tauriConfig.build.beforeBuildCommand, /frontend:build/);
assert.match(tauriConfig.build.beforeBuildCommand, /npm run release:prepare/);
assert.doesNotMatch(
  JSON.stringify(tauriConfig.build),
  /sync-frontend|prepare-tauri-dist|dev-static-server/
);

assert.equal(packageJson.scripts['frontend:sync'], undefined);
assert.equal(packageJson.scripts['frontend:check'], undefined);
assert.equal(packageJson.scripts.postinstall, undefined);
assert.equal(packageJson.dependencies['chart.js'] != null, true);
assert.match(packageJson.scripts['release:prepare'], /prepare-release-runtime\.js/);

for (const removedPath of [
  'electron-ui.html',
  'app.css',
  'app-ux.js',
  'app-bridge.js',
  'app-audit.js',
  'app-cli.js',
  'app-diagnostics.js',
  'app-tool-status.js',
  'app-environment.js',
  'app-mcp.js',
  'app.js',
  'tauri-ui/electron-ui.html',
  'scripts/sync-frontend.js',
  'scripts/prepare-tauri-dist.js',
]) {
  assert.equal(
    fs.existsSync(path.join(repoRoot, removedPath)),
    false,
    `${removedPath} must stay removed`
  );
}

console.log('[frontend-build-governance.test] ok');
