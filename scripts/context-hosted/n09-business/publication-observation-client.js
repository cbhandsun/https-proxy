'use strict';
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: pause } = require('node:timers/promises');
const { fields } = require('../n09-ack/contract');
const { readBootstrap, physical } = require('../n09-ack/bootstrap-client');
const { createN09BootstrapContract } = require('../n09-ack/bootstrap-contract');
const { createPublicationObservationContract } = require('./publication-observation-contract');
const { createPublicationObservationFiles } = require('./publication-observation-files');
const fail = () => new Error('n09_publication_client_rejected');
function createPublicationObservationClient(input) {
  let bootstrap, contract, files;
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
    physical(runtimeDir, true, pins);
    const directory = path.join(path.dirname(runtimeDir), 'n09-ack');
    physical(directory, true, pins);
    bootstrap = createN09BootstrapContract({
      token: config.token,
      pid,
      manifestSha256: config.manifestSha256,
    });
    const payload = bootstrap.verify(
      readBootstrap(path.join(directory, 'bootstrap-' + pid + '.json'))
    );
    physical(runtimeDir, true, pins);
    physical(directory, true, pins);
    contract = createPublicationObservationContract({
      pid,
      epoch: payload.epoch,
      signingKey: bootstrap.mailboxKey(payload),
    });
    files = createPublicationObservationFiles({
      directory: path.join(
        path.dirname(runtimeDir),
        'n09-publication-' + pid + '-' + payload.epoch
      ),
      pid,
      epoch: payload.epoch,
    });
    let sequence = 0,
      closed = false,
      failed = false,
      pending = false,
      closeFailed = false;
    return Object.freeze({
      async query(timeoutMs = 750) {
        try {
          if (
            closed ||
            failed ||
            pending ||
            sequence === 16 ||
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > 750
          )
            throw fail();
          pending = true;
          const deadline = performance.now() + timeoutMs;
          const request = {
            version: 1,
            pid,
            epoch: payload.epoch,
            sequence: ++sequence,
            challenge: randomBytes(16).toString('hex'),
          };
          files.write('query', sequence, JSON.stringify(contract.signQuery(request)));
          for (;;) {
            if (closed || performance.now() >= deadline) throw fail();
            const wire = files.read('state', sequence);
            if (wire !== null) {
              const result = contract.verifyState(wire);
              if (
                result.sequence !== request.sequence ||
                result.challenge !== request.challenge ||
                performance.now() >= deadline
              )
                throw fail();
              physical(runtimeDir, true, pins);
              physical(directory, true, pins);
              if (performance.now() >= deadline) throw fail();
              return result;
            }
            await pause(Math.min(10, Math.max(1, deadline - performance.now())));
          }
        } catch {
          failed = true;
          throw fail();
        } finally {
          pending = false;
        }
      },
      close() {
        if (closed) {
          if (closeFailed) throw fail();
          return;
        }
        closed = true;
        for (const resource of [files, contract, bootstrap]) {
          try {
            resource.close();
          } catch {
            closeFailed = true;
          }
        }
        if (closeFailed) throw fail();
      },
    });
  } catch {
    for (const resource of [files, contract, bootstrap]) {
      try {
        resource?.close();
      } catch {
        /* rejected */
      }
    }
    throw fail();
  }
}
module.exports = { createPublicationObservationClient };
