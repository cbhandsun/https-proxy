'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createPublicationAckContract,
} = require('../../scripts/context-hosted/n09-business/publication-ack-contract');
const config = { pid: 123, epoch: 'a'.repeat(32), signingKey: 'b'.repeat(64) };
const make = () => createPublicationAckContract(config);
const payload = (kind = 'arm') => ({
  version: 1,
  pid: config.pid,
  epoch: config.epoch,
  challenge: 'c'.repeat(32),
  kind,
  generation: 1,
  callOrdinal: 1,
  rootId: 'hbs_' + 'd'.repeat(32),
  expiresAt: 123456,
  expectedRevision: 7,
  transition: 'prepared',
  holdChallenge: ['arm', 'armed'].includes(kind) ? '' : 'e'.repeat(32),
  revision: ['arm', 'armed'].includes(kind) ? 7 : 8,
});
const rejected = (fn) => assert.throws(fn, { message: 'n09_publication_ack_control_rejected' });

test('ACK control authenticates all five transitions and message kinds with frozen finite facts', () => {
  const signer = make(),
    verifier = make();
  try {
    for (const transition of [
      'prepared',
      'sending',
      'transport-finished',
      'uncertain',
      'withdrawn',
    ]) {
      for (const kind of ['arm', 'release', 'armed', 'held', 'released']) {
        const value = { ...payload(kind), transition };
        const signal = !['arm', 'release'].includes(kind);
        const signed = signer[signal ? 'signSignal' : 'signCommand'](value);
        const verified = verifier[signal ? 'verifySignal' : 'verifyCommand'](signed);
        assert.deepEqual(verified, value);
        assert.ok(Object.isFrozen(signed) && Object.isFrozen(verified));
        assert.deepEqual(Object.keys(verified), Object.keys(payload()));
      }
    }
  } finally {
    signer.close();
    verifier.close();
  }
});

test('ACK control rejects tampering, another key, process, epoch and command/signal substitution', () => {
  const contract = make();
  const signed = contract.signSignal(payload('held'));
  for (const name of Object.keys(signed.payload)) {
    rejected(() =>
      contract.verifySignal({ ...signed, payload: { ...signed.payload, [name]: null } })
    );
  }
  for (const change of [{ signingKey: 'f'.repeat(64) }, { pid: 124 }, { epoch: 'f'.repeat(32) }]) {
    const other = createPublicationAckContract({ ...config, ...change });
    rejected(() => other.verifySignal(signed));
    other.close();
  }
  rejected(() => contract.verifyCommand(signed));
  rejected(() => contract.verifySignal({ ...signed, signature: '0'.repeat(64) }));
  rejected(() => contract.verifySignal({ ...signed, extra: true }));
  contract.close();
});

test('ACK control rejects empty, illegal and extreme bounds without granting a revision', () => {
  const contract = make();
  for (const value of [null, undefined, [], {}, '', 0]) rejected(() => contract.signCommand(value));
  for (const [name, values] of Object.entries({
    version: [0, 2],
    pid: [0, 124],
    epoch: ['', 'A'.repeat(32)],
    challenge: ['', 'g'.repeat(32)],
    kind: ['held', 'unknown'],
    generation: [0, 17, NaN],
    callOrdinal: [0, 1024, Infinity],
    rootId: ['', '../private'],
    expiresAt: [0, -1, 1.2],
    expectedRevision: [0, Number.MAX_SAFE_INTEGER],
    transition: ['', 'none'],
    holdChallenge: ['e'.repeat(32)],
    revision: [0, 6, 8],
  }))
    for (const value of values)
      rejected(() => contract.signCommand({ ...payload(), [name]: value }));
  for (const kind of ['release', 'held', 'released']) {
    const sign = kind === 'release' ? 'signCommand' : 'signSignal';
    rejected(() => contract[sign]({ ...payload(kind), holdChallenge: '' }));
    rejected(() => contract[sign]({ ...payload(kind), revision: 9 }));
  }
  const limit = {
    ...payload('held'),
    generation: 16,
    callOrdinal: 1024,
    expiresAt: Number.MAX_SAFE_INTEGER,
    expectedRevision: Number.MAX_SAFE_INTEGER - 1,
    revision: Number.MAX_SAFE_INTEGER,
  };
  assert.deepEqual(contract.verifySignal(contract.signSignal(limit)), limit);
  contract.close();
});

test('ACK control does not invoke getters or proxy traps or disclose caller input', () => {
  let touched = 0;
  const contract = make();
  const accessor = { ...payload() };
  Object.defineProperty(accessor, 'rootId', {
    enumerable: true,
    get() {
      touched++;
      throw Error('secret');
    },
  });
  const proxy = new Proxy(payload(), {
    ownKeys() {
      touched++;
      throw Error('secret');
    },
  });
  for (const value of [
    accessor,
    proxy,
    { ...payload(), secret: 'do-not-disclose' },
    { ...payload(), [Symbol('secret')]: 1 },
  ])
    rejected(() => contract.signCommand(value));
  rejected(() =>
    contract.verifySignal(
      new Proxy(
        {},
        {
          ownKeys() {
            touched++;
          },
        }
      )
    )
  );
  assert.equal(touched, 0);
  contract.close();
});

test('ACK control closes idempotently and refuses every capability after close', () => {
  const contract = make();
  const command = contract.signCommand(payload());
  const signal = contract.signSignal(payload('held'));
  contract.close();
  contract.close();
  for (const [method, value] of [
    ['signCommand', payload()],
    ['verifyCommand', command],
    ['signSignal', payload('held')],
    ['verifySignal', signal],
  ])
    rejected(() => contract[method](value));
  for (const value of [
    null,
    {},
    { ...config, pid: 0 },
    { ...config, epoch: '' },
    { ...config, signingKey: '' },
    { ...config, extra: 1 },
  ])
    rejected(() => createPublicationAckContract(value));
});
