'use strict';

const path = require('node:path');

function nativeProbePermissionArgs(root) {
  if (
    typeof root !== 'string' ||
    root.length > 1024 ||
    root.includes('\0') ||
    !path.isAbsolute(root) ||
    !/^hpm-tianxi-codex-native-[A-Za-z0-9_-]+$/.test(path.basename(root)) ||
    path.resolve(root) !== root
  )
    throw new Error('tianxi_codex_probe_workspace_invalid');
  // --ignore-user-config also omits the Windows sandbox implementation. A
  // workspace profile alone cannot supply that implementation for apply_patch.
  return [
    '-c',
    'default_permissions=":workspace"',
    '-c',
    'windows.sandbox="elevated"',
    '-C',
    root,
    '--add-dir',
    root,
    '-c',
    `projects.${JSON.stringify(root)}.trust_level="trusted"`,
  ];
}

module.exports = { nativeProbePermissionArgs };
