'use strict';

const path = require('node:path');
const { fields, fail } = require('./contract');
const { installN09RuntimeHooks } = require('./runtime-hooks');
const { createN09MailboxHost } = require('./mailbox');
const {
  installPublicationStorageObserver,
} = require('../n09-business/publication-storage-observer');
const {
  createPublicationObservationHost,
} = require('../n09-business/publication-observation-host');
const { createPublicationAckHost } = require('../n09-business/publication-ack-host');

// Called only by the granted gate, after every helper and installed source hash
// has been verified. Installed imports below are fixed, reviewed targets.
function installN09HostAck(input) {
  let hooks, publicationObserver, publicationHost, ackHost, host;
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
      'context-recovery-storage.js',
      'context-recovery-storage-opening.js',
    ])
      if (require.cache[require.resolve(path.join(options.install, 'lib/proxy', name))])
        throw fail();
    const ackExports = require(
      path.join(options.install, 'lib/proxy/context-recovery-durable-ack.js')
    );
    const storageExports = require(
      path.join(options.install, 'lib/proxy/context-recovery-storage.js')
    );
    const storageContract = require(
      path.join(options.install, 'lib/proxy/context-recovery-storage-contract.js')
    );
    const storageInventory = require(
      path.join(options.install, 'lib/proxy/context-recovery-storage-inventory.js')
    );
    publicationObserver = installPublicationStorageObserver({
      storageExports,
      storageContract,
      storageInventory,
      expectedDirectory: path.join(options.caseRoot, 'runtime/context-recovery-v1'),
    });
    const lifecycleExports = require(
      path.join(options.install, 'lib/proxy/context-recovery-lifecycle.js')
    );
    if (
      require.cache[
        require.resolve(path.join(options.install, 'lib/proxy/context-recovery-root-storage.js'))
      ]
    )
      throw fail();
    ackHost = createPublicationAckHost(
      {
        caseRoot: options.caseRoot,
        pid: options.pid,
        epoch: options.epoch,
        signingKey: options.signingKey,
      },
      publicationObserver
    );
    hooks = installN09RuntimeHooks({
      ackExports,
      lifecycleExports,
      expectedDirectory: path.join(options.caseRoot, 'runtime/context-recovery-v1'),
      pid: options.pid,
      epoch: options.epoch,
      afterDurableAck: (facts) => ackHost.afterDurableAck(facts),
    });
    publicationHost = createPublicationObservationHost(
      {
        caseRoot: options.caseRoot,
        pid: options.pid,
        epoch: options.epoch,
        signingKey: options.signingKey,
      },
      publicationObserver
    );
    let closed = false,
      closeFailed = false;
    const combinedHooks = Object.freeze({
      armSave: (...args) => hooks.armSave(...args),
      revokeBoundRoot: (...args) => hooks.revokeBoundRoot(...args),
      close() {
        if (closed) {
          if (closeFailed) throw fail();
          return;
        }
        closed = true;
        for (const resource of [ackHost, publicationHost, hooks]) {
          try {
            resource.close();
          } catch {
            closeFailed = true;
          }
        }
        if (closeFailed) throw fail();
      },
    });
    host = createN09MailboxHost(
      {
        directory: path.join(options.caseRoot, 'n09-ack'),
        pid: options.pid,
        epoch: options.epoch,
        signingKey: options.signingKey,
      },
      combinedHooks
    );
    host.start();
    publicationHost.start();
    ackHost.start();
    return host;
  } catch {
    for (const resource of host
      ? [host]
      : [ackHost, publicationHost ?? publicationObserver, hooks]) {
      try {
        resource?.close();
      } catch {
        // Continue restoring all installed exports before reporting rejection.
      }
    }
    throw fail();
  }
}

module.exports = { installN09HostAck };
