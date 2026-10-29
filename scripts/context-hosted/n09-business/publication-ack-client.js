'use strict';

const path = require('node:path');
const { fields } = require('../n09-ack/contract');
const { physical, readBootstrap } = require('../n09-ack/bootstrap-client');
const { createN09BootstrapContract } = require('../n09-ack/bootstrap-contract');
const { createPublicationAckChannel } = require('./publication-ack-channel');
const fail = () => new Error('n09_publication_ack_client_rejected');

function createPublicationAckClient(input) {
  let bootstrap, channel;
  try {
    const config = fields(input, ['runtimeDir', 'pid', 'manifestSha256', 'token']);
    const { runtimeDir, pid } = config;
    if (
      typeof runtimeDir !== 'string' ||
      !path.isAbsolute(runtimeDir) ||
      path.basename(runtimeDir) !== 'runtime' ||
      runtimeDir.length > 4096 ||
      /^[\\/]{2}/.test(runtimeDir) ||
      /[\0\r\n]/.test(runtimeDir) ||
      runtimeDir.split(/[\\/]/).some((part) => part === '.' || part === '..')
    )
      throw fail();
    const pins = new Map();
    const directory = path.join(path.dirname(runtimeDir), 'n09-ack');
    const validate = () => {
      physical(runtimeDir, true, pins);
      physical(directory, true, pins);
    };
    validate();
    bootstrap = createN09BootstrapContract({
      token: config.token,
      pid,
      manifestSha256: config.manifestSha256,
    });
    const grant = bootstrap.verify(
      readBootstrap(path.join(directory, 'bootstrap-' + pid + '.json'))
    );
    validate();
    channel = createPublicationAckChannel({
      caseRoot: path.dirname(runtimeDir),
      pid,
      epoch: grant.epoch,
      signingKey: bootstrap.mailboxKey(grant),
    });
    let closed = false,
      failed = false;
    function available() {
      if (closed || failed) throw fail();
      validate();
    }
    async function call(name, ...args) {
      try {
        available();
        const result = await channel[name](...args);
        available();
        return result;
      } catch {
        failed = true;
        throw fail();
      }
    }
    function command(name) {
      try {
        available();
        channel[name]();
        available();
      } catch {
        failed = true;
        throw fail();
      }
    }
    return Object.freeze({
      arm: (target) => call('arm', target),
      waitHeld: () => call('waitHeld'),
      armCancellation: (target) => call('armCancellation', target),
      waitTriggerHeld: () => call('waitTriggerHeld'),
      releaseTrigger: () => command('releaseTrigger'),
      release: () => command('release'),
      waitReleased: () => call('waitReleased'),
      close() {
        closed = true;
        channel.close();
        bootstrap.close();
      },
    });
  } catch {
    for (const resource of [channel, bootstrap]) {
      try {
        resource?.close();
      } catch {
        /* rejected */
      }
    }
    throw fail();
  }
}

module.exports = { createPublicationAckClient };
