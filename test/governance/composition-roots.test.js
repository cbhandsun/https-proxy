'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const lineBudgets = {
  'openai-proxy.js': 1153,
  'src-tauri/src/desktop_shell.rs': 414,
  'src-tauri/src/lib.rs': 803,
  'src-tauri/src/main.rs': 10,
  'tauri-ui/src/app/bootstrap.js': 4215,
  'tauri-ui/src/main.js': 5,
};

for (const [relativePath, budget] of Object.entries(lineBudgets)) {
  const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
  const lineCount = source.split(/\r?\n/).length;
  assert.ok(
    lineCount <= budget,
    `${relativePath} has ${lineCount} lines; composition-root budget is ${budget}`
  );
}

const nodeEntry = fs.readFileSync(path.join(repoRoot, 'openai-proxy.js'), 'utf8');
assert.match(nodeEntry, /createRuntimeHttpAgents\(\{ loadConfig \}\)/);
assert.doesNotMatch(nodeEntry, /function shouldVerifyUpstreamTls\(/);

const tauriEntry = fs.readFileSync(path.join(repoRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
assert.match(tauriEntry, /mod proxy_root;/);
assert.match(tauriEntry, /mod desktop_shell;/);
assert.doesNotMatch(tauriEntry, /fn push_proxy_root_ancestors\(/);
assert.doesNotMatch(tauriEntry, /TrayIconBuilder|fn create_custom_menu\(/);
const desktopShell = fs.readFileSync(
  path.join(repoRoot, 'src-tauri', 'src', 'desktop_shell.rs'),
  'utf8'
);
assert.match(desktopShell, /pub\(crate\) fn configure_desktop_shell\(/);
assert.match(desktopShell, /pub\(crate\) fn handle_app_menu_event\(/);
assert.match(desktopShell, /TrayIconBuilder::new\(\)/);

const frontendEntry = fs.readFileSync(path.join(repoRoot, 'tauri-ui', 'src', 'main.js'), 'utf8');
assert.equal(
  frontendEntry.trim().replaceAll('\r\n', '\n'),
  "import './styles/app.css';\nimport './app/bootstrap.js';"
);

console.log('[composition-roots.test] ok');
