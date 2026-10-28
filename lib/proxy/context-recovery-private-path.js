'use strict';

const { execFileSync } = require('node:child_process');
const { securePrivatePathSync } = require('./secure-files');
const { securePrivatePathNative, prepareStorageDirectoryNative } = require('./private-path-native');
const { storageFailure } = require('./context-recovery-storage-contract');

// Only a missing default binary (or a non-Windows host) permits compatibility
// dispatch. A native failure never retries through another backend.
function secureRecoveryStoragePath(file, kind, options = {}) {
  try {
    if (!securePrivatePathNative(file, kind, options)) {
      const execute = options.execute ?? execFileSync;
      securePrivatePathSync(file, kind, {
        platform: options.platform ?? process.platform,
        force: true,
        environment: {
          SystemRoot: process.env.SystemRoot || process.env.WINDIR,
          WINDIR: process.env.WINDIR || process.env.SystemRoot,
        },
        execFileSync(command, args, settings) {
          return execute(command, args, {
            ...settings,
            timeout: 5000,
            maxBuffer: 16384,
            windowsHide: true,
          });
        },
      });
    }
    return file;
  } catch {
    throw storageFailure();
  }
}

function prepareRecoveryStorageDirectory(directory, onDispatch) {
  try {
    return prepareStorageDirectoryNative(directory, { onDispatch });
  } catch {
    throw storageFailure();
  }
}

module.exports = { secureRecoveryStoragePath, prepareRecoveryStorageDirectory };
