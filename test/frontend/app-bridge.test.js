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

console.log('[app-bridge.test] ok');
