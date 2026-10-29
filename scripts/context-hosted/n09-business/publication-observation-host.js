'use strict';
const path = require('node:path');
const { types } = require('node:util');
const { fields, discardN09PromiseRejection } = require('../n09-ack/contract');
const { createPublicationObservationContract } = require('./publication-observation-contract');
const { createPublicationObservationFiles } = require('./publication-observation-files');
const fail = () => new Error('n09_publication_host_rejected');
const stateKeys = [
  'generation',
  'callOrdinal',
  'activeCount',
  'operation',
  'transition',
  'rootId',
  'expiresAt',
  'expectedRevision',
  'status',
];
function createPublicationObservationHost(input, observer) {
  let files, contract;
  try {
    const config = fields(input, ['caseRoot', 'pid', 'epoch', 'signingKey']);
    const methods = fields(observer, ['inspect', 'close']);
    if (
      Object.values(methods).some(
        (value) =>
          typeof value !== 'function' || types.isProxy(value) || types.isAsyncFunction(value)
      )
    )
      throw fail();
    contract = createPublicationObservationContract({
      pid: config.pid,
      epoch: config.epoch,
      signingKey: config.signingKey,
    });
    files = createPublicationObservationFiles(
      {
        directory: path.join(config.caseRoot, 'n09-publication-' + config.pid + '-' + config.epoch),
        pid: config.pid,
        epoch: config.epoch,
      },
      true
    );
    let sequence = 0,
      closed = false,
      failed = false,
      closeFailed = false,
      timer;
    const challenges = new Set();
    function step() {
      if (closed || failed) throw fail();
      if (sequence === 16) return 'exhausted';
      try {
        const at = sequence + 1,
          wire = files.read('query', at);
        if (wire === null) return 'idle';
        const query = contract.verifyQuery(wire);
        if (query.sequence !== at || challenges.has(query.challenge)) throw fail();
        sequence = at;
        challenges.add(query.challenge);
        const snapshot = fields(Reflect.apply(methods.inspect, observer, []), stateKeys);
        files.write('state', at, JSON.stringify(contract.signState({ ...query, ...snapshot })));
        return 'observed';
      } catch {
        failed = true;
        if (timer) clearInterval(timer);
        timer = undefined;
        throw fail();
      }
    }
    return Object.freeze({
      step,
      start() {
        if (closed || failed || timer) throw fail();
        timer = setInterval(() => {
          try {
            step();
          } catch {
            /* No reply can qualify after failure. */
          }
        }, 10);
        timer.unref();
      },
      close() {
        if (closed) {
          if (closeFailed) throw fail();
          return;
        }
        closed = true;
        if (timer) clearInterval(timer);
        timer = undefined;
        for (const resource of [files, contract, observer]) {
          try {
            const result = resource.close();
            if (result !== undefined) {
              discardN09PromiseRejection(result);
              throw fail();
            }
          } catch {
            closeFailed = true;
          }
        }
        if (closeFailed) throw fail();
      },
    });
  } catch {
    for (const resource of [files, contract]) {
      try {
        resource?.close();
      } catch {
        /* construction is rejected */
      }
    }
    throw fail();
  }
}
module.exports = { createPublicationObservationHost };
