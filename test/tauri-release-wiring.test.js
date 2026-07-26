'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const rustLib = fs.readFileSync(path.join(repoRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
const rustCodexLogin = fs.readFileSync(
  path.join(repoRoot, 'src-tauri', 'src', 'codex_login.rs'),
  'utf8'
);
const rustMain = fs.readFileSync(path.join(repoRoot, 'src-tauri', 'src', 'main.rs'), 'utf8');
const permissions = fs.readFileSync(
  path.join(repoRoot, 'src-tauri', 'permissions', 'app-commands.toml'),
  'utf8'
);
const tauriConfig = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8')
);
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const installerHooks = fs.readFileSync(
  path.join(repoRoot, 'src-tauri', 'nsis', 'installer-hooks.nsh'),
  'utf8'
);

function registeredTauriCommands(source) {
  const match = source.match(/\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/);
  assert.ok(match, 'Tauri invoke handler registration must be present');
  return match[1]
    .split(',')
    .map((command) => command.trim())
    .filter(Boolean);
}

function allowedTauriCommands(source) {
  const match = source.match(/\[permission\.commands\][\s\S]*?allow\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(match, 'Tauri custom command allow-list must be present');
  return Array.from(match[1].matchAll(/"([^"]+)"/g), (entry) => entry[1]);
}

const registered = registeredTauriCommands(rustLib);
const allowed = new Set(allowedTauriCommands(permissions));
const missingPermissions = registered.filter((command) => !allowed.has(command));
assert.deepStrictEqual(
  missingPermissions,
  [],
  `registered Tauri commands missing from ACL: ${missingPermissions.join(', ')}`
);

const autostartCalls = `${rustMain}\n${rustLib}`.match(/request_proxy_autostart\(\);/g) || [];
assert.strictEqual(
  autostartCalls.length,
  1,
  'desktop composition must request proxy autostart once'
);
assert.ok(
  !rustMain.includes('request_proxy_autostart();'),
  'main remains a composition root without duplicate proxy lifecycle work'
);

const setupIndex = rustLib.indexOf('.setup(|app|');
const resourceRootIndex = rustLib.indexOf('RESOURCE_ROOT.set(resource_dir)', setupIndex);
const autostartIndex = rustLib.indexOf('request_proxy_autostart();', setupIndex);
assert.ok(setupIndex >= 0, 'Tauri setup hook must be present');
assert.ok(resourceRootIndex > setupIndex, 'setup must resolve the bundled resource root');
assert.ok(
  autostartIndex > resourceRootIndex,
  'proxy autostart must run after the bundled resource root is available'
);

assert.strictEqual(
  tauriConfig.bundle.windows.nsis.installerHooks,
  'nsis/installer-hooks.nsh',
  'NSIS builds must include the process cleanup hooks'
);
assert.strictEqual(
  tauriConfig.bundle.windows.nsis.installMode,
  'currentUser',
  'the fixed cleanup directory must match the current-user NSIS install mode'
);
assert.match(installerHooks, /!macro NSIS_HOOK_PREINSTALL/);
assert.match(installerHooks, /!macro NSIS_HOOK_PREUNINSTALL/);
assert.match(installerHooks, /stop-installed-processes\.ps1/);
assert.match(installerHooks, /Process cleanup diagnostics/);
assert.match(installerHooks, /\$1 != ""/);
assert.match(installerHooks, /StrCpy \$R9 "\$LOCALAPPDATA\\HTTPS Proxy Manager"/);
assert.ok(
  !installerHooks.includes('-InstallDir'),
  'NSIS must derive the current-user install directory inside PowerShell instead of quoting it on the command line'
);
assert.match(
  installerHooks,
  /!define HTTPS_PROXY_INSTALLER_HOOK_DIR "\$\{__FILEDIR__\}"/,
  'hook directory must be captured while NSIS reads the source hook, before macro expansion'
);
assert.match(
  installerHooks,
  /"\$\{HTTPS_PROXY_INSTALLER_HOOK_DIR\}\\stop-installed-processes\.ps1"/,
  'embedded cleanup script must resolve relative to the source hook directory'
);

const verifyScript = String((packageJson.scripts && packageJson.scripts.verify) || '');
const rustTestScript = String((packageJson.scripts && packageJson.scripts['test:rust']) || '');
assert.ok(
  verifyScript.includes('npm run test:rust'),
  'the unified verification gate must run the self-contained Rust test gate'
);
assert.ok(
  rustTestScript.indexOf('npm run release:prepare') <
    rustTestScript.indexOf('cargo test --manifest-path src-tauri/Cargo.toml'),
  'the Rust test gate must prepare release resources before compiling the Tauri context'
);
assert.match(
  rustCodexLogin,
  /fn launch_codex_login_script\(\) -> Result<serde_json::Value, String>/,
  'the native login launcher must not accept an executable path from the renderer'
);
assert.ok(
  rustCodexLogin.includes('CODEX_LOGIN_SCRIPT_FILE_NAME'),
  'the native login launcher must use the fixed managed Codex login script'
);
assert.ok(
  !rustCodexLogin.includes('"Bypass"'),
  'the native login launcher must not bypass the PowerShell execution policy'
);

console.log('[tauri-release-wiring.test] ok');
