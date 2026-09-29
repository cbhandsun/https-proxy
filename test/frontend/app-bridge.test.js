'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'tauri-ui', 'src', 'app', 'domains', 'bridge.js'),
  'utf8'
);

assert.ok(
  source.includes("invoke('management_fetch_native'"),
  'Tauri management requests must stay inside the native authenticated bridge'
);
assert.ok(
  !source.includes("invoke('get_management_token_native'"),
  'the renderer must never receive the raw management token'
);
assert.ok(
  !source.includes('x-mgmt-token'),
  'the renderer must never construct management authentication headers'
);
assert.ok(
  source.includes("localStorage.removeItem('hpm_mgmt_token')"),
  'startup must remove legacy persisted management tokens'
);
assert.ok(
  !source.includes("localStorage.getItem('hpm_mgmt_token')"),
  'management tokens must never be read from localStorage'
);
assert.ok(
  !source.includes("localStorage.setItem('hpm_mgmt_token'"),
  'management tokens must never be persisted to localStorage'
);
assert.ok(
  source.includes("invoke('launch_codex_login_script')"),
  'the native Codex login launcher must resolve its own fixed script path'
);
assert.ok(
  !source.includes("invoke('launch_codex_login_script',"),
  'the renderer must not provide an executable script path to the native launcher'
);
for (const command of [
  'apply_app_menu',
  'execute_app_shortcut',
  'open_config',
  'open_log',
  'open_cert_dir',
]) {
  assert.ok(
    source.includes(`invoke('${command}'`),
    `native command must use Rust name: ${command}`
  );
}
for (const legacyCommand of [
  'applyAppMenu',
  'executeAppShortcut',
  'openConfig',
  'openLog',
  'openCertDir',
]) {
  assert.ok(
    !source.includes(`invoke('${legacyCommand}'`),
    `legacy camelCase Tauri command must stay removed: ${legacyCommand}`
  );
}
assert.ok(
  source.includes('derivedPort <= 65535') && source.includes(': 3543'),
  'browser management-port fallback must reject derived ports outside the TCP range'
);

console.log('[app-bridge.test] ok');
