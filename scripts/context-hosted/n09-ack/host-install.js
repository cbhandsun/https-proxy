'use strict';

const path = require('node:path');
const { fields, fail } = require('./contract');
const { installN09RuntimeHooks } = require('./runtime-hooks');
const { createN09MailboxHost } = require('./mailbox');

// Called only by the granted gate, after every helper and installed source hash
// has been verified. These two installed imports are fixed, reviewed targets.
function installN09HostAck(input) {
  let hooks;
  try {
    const options = fields(input, ['install', 'caseRoot', 'pid', 'epoch', 'signingKey']);
    if (
      !Number.isSafeInteger(options.pid) ||
      options.pid < 1 ||
      typeof options.epoch !== 'string' ||
      !/^[a-f0-9]{32}$/.test(options.epoch) ||
      typeof options.signingKey !== 'string' ||
      !/^[a-f0-9]{64}$/.test(options.signingKey)
    )
      throw fail();
    for (const directory of [options.install, options.caseRoot])
      if (
        typeof directory !== 'string' ||
        directory.length > 4096 ||
        [...directory].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ) ||
        !path.isAbsolute(directory) ||
        /^[\\/]{2}/.test(directory) ||
        directory.split(/[\\/]/).some((part) => part === '.' || part === '..')
      )
        throw fail();
    // Capturing either export after root-storage has destructured the producer
    // cannot prove actual save observations. Refuse warm/ambiguous ownership.
    for (const name of [
      'context-recovery-root-storage.js',
      'context-recovery-durable-ack.js',
      'context-recovery-lifecycle.js',
    ])
      if (require.cache[require.resolve(path.join(options.install, 'lib/proxy', name))])
        throw fail();
    const ackExports = require(
      path.join(options.install, 'lib/proxy/context-recovery-durable-ack.js')
    );
    const lifecycleExports = require(
      path.join(options.install, 'lib/proxy/context-recovery-lifecycle.js')
    );
    if (
      require.cache[
        require.resolve(path.join(options.install, 'lib/proxy/context-recovery-root-storage.js'))
      ]
    )
      throw fail();
    hooks = installN09RuntimeHooks({
      ackExports,
      lifecycleExports,
      expectedDirectory: path.join(options.caseRoot, 'runtime/context-recovery-v1'),
      pid: options.pid,
      epoch: options.epoch,
    });
    const host = createN09MailboxHost(
      {
        directory: path.join(options.caseRoot, 'n09-ack'),
        pid: options.pid,
        epoch: options.epoch,
        signingKey: options.signingKey,
      },
      hooks
    );
    host.start();
    return host;
  } catch {
    if (hooks) {
      try {
        hooks.close();
      } catch {
        throw fail();
      }
    }
    throw fail();
  }
}

module.exports = { installN09HostAck };
