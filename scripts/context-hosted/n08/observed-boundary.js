'use strict';

const { types } = require('node:util');

// Pure boundary only. The synthetic upstream owns response bytes and sockets.
const BARRIERS = Object.freeze(['read-tool-response', 'public-final-response']);
const MUTATIONS = Object.freeze(['disable', 'target-change', 'permission-change']);
const fail = () => new Error('n08_boundary_rejected');
function snapshotOwnData(input) {
  try {
    if (
      !input ||
      typeof input !== 'object' ||
      types.isProxy(input) ||
      Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      throw fail();
    const slots = Object.getOwnPropertyDescriptors(input);
    const result = Object.create(null);
    for (const name of Reflect.ownKeys(slots)) {
      if (
        typeof name !== 'string' ||
        !slots[name].enumerable ||
        !Object.hasOwn(slots[name], 'value') ||
        types.isProxy(slots[name].value)
      )
        throw fail();
      result[name] = slots[name].value;
    }
    return result;
  } catch {
    throw fail();
  }
}
function exact(input, names) {
  const snapshot = snapshotOwnData(input);
  if (
    Reflect.ownKeys(snapshot).length !== names.length ||
    names.some((name) => !Object.hasOwn(snapshot, name))
  )
    throw fail();
  const result = Object.create(null);
  for (const name of names) result[name] = snapshot[name];
  return result;
}
function parseOwner(input) {
  const value = exact(input, ['pid', 'manifestSha256', 'nonce']);
  if (
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.manifestSha256) ||
    typeof value.nonce !== 'string' ||
    !/^[a-f0-9]{32}$/.test(value.nonce)
  )
    throw fail();
  return Object.freeze(value);
}
function ack(identity, barrier, mutation, stage) {
  return Object.freeze({ ...identity, barrier, mutation, stage, ack: true });
}
function checkAck(input, identity, barrier, mutation, stage) {
  const value = exact(input, [
    'pid',
    'manifestSha256',
    'nonce',
    'barrier',
    'mutation',
    'stage',
    'ack',
  ]);
  if (
    Object.entries(ack(identity, barrier, mutation, stage)).some(
      ([key, expected]) => value[key] !== expected
    )
  )
    throw fail();
}
function createResponseHold(input, capabilities) {
  const { owner, barrier, mutation } = exact(input, ['owner', 'barrier', 'mutation']);
  const identity = parseOwner(owner);
  if (!BARRIERS.includes(barrier) || !MUTATIONS.includes(mutation)) throw fail();
  const methods = exact(capabilities, ['deliver', 'cancel']);
  if (typeof methods.deliver !== 'function' || typeof methods.cancel !== 'function') throw fail();
  let state = 'armed';
  return Object.freeze({
    arrive(inputEvent) {
      const event = exact(inputEvent, [
        'nonce',
        'ordinal',
        'readToolCalls',
        'finalTextItems',
        'publicWrites',
      ]);
      if (
        state !== 'armed' ||
        event.nonce !== identity.nonce ||
        event.ordinal !== 1 ||
        event.publicWrites !== 0 ||
        event.readToolCalls !== (barrier === 'read-tool-response' ? 1 : 0) ||
        event.finalTextItems !== (barrier === 'public-final-response' ? 1 : 0)
      )
        throw fail();
      state = 'held';
      return ack(identity, barrier, mutation, 'upstream-response-held');
    },
    mutationApplied(receipt) {
      if (state !== 'held') throw fail();
      checkAck(receipt, identity, barrier, mutation, 'mutation-applied');
      state = 'mutated';
    },
    async release() {
      if (state !== 'mutated') throw fail();
      state = 'releasing';
      try {
        if ((await methods.deliver()) !== true || state !== 'releasing') throw fail();
        state = 'released';
        return ack(identity, barrier, mutation, 'response-released');
      } catch {
        state = 'failed';
        throw fail();
      }
    },
    async cancel() {
      if (state === 'cancelled') return;
      if (state === 'cancelling') throw fail();
      state = 'cancelling';
      try {
        if ((await methods.cancel()) !== true) throw fail();
        state = 'cancelled';
      } catch {
        state = 'failed';
        throw fail();
      }
    },
    inspect: () => state,
  });
}
const HIDDEN = Object.freeze([
  'N08_PRIVATE_CONTENT',
  'N08_PUBLIC_RESULT',
  'hpm_list_retained_evidence',
  'hpm_read_retained_evidence',
]);
function wire(input, ordinary = false, safeFallback = false) {
  const value = exact(input, ['status', 'bytes']);
  if (
    !Number.isInteger(value.status) ||
    !Buffer.isBuffer(value.bytes) ||
    value.bytes.length > 262144 ||
    !(
      ordinary
        ? [200]
        : safeFallback
          ? [0, 200, 400, 403, 409, 410, 499, 502, 503]
          : [0, 400, 403, 409, 410, 499, 502, 503]
    ).includes(value.status) ||
    (value.status === 0 && value.bytes.length !== 0)
  )
    throw fail();
  const bytes = Buffer.from(value.bytes);
  if (HIDDEN.some((marker) => bytes.includes(Buffer.from(marker)))) throw fail();
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw fail();
  if (value.status === 0) return { status: 0, body: null };
  let response;
  try {
    response = JSON.parse(text);
  } catch {
    throw fail();
  }
  // Inspect every JSON string token too, including values hidden by duplicate keys.
  for (const token of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
    const decoded = JSON.parse(token[0]);
    if (HIDDEN.some((marker) => decoded.includes(marker))) throw fail();
  }
  let nodes = 0;
  function inspect(value, depth) {
    if (++nodes > 4096 || depth > 32) throw fail();
    if (typeof value === 'string' && HIDDEN.some((marker) => value.includes(marker))) throw fail();
    if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) {
        if (HIDDEN.some((marker) => key.includes(marker))) throw fail();
        inspect(child, depth + 1);
      }
  }
  inspect(response, 0);
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw fail();
  if (ordinary || (safeFallback && value.status === 200)) {
    if (
      response.id !== 'n08-ordinary-default' ||
      response.object !== 'response' ||
      response.status !== 'completed' ||
      !Array.isArray(response.output) ||
      response.output.length !== 1 ||
      response.output[0]?.type !== 'message' ||
      !Array.isArray(response.output[0].content) ||
      response.output[0].content.length !== 1 ||
      response.output[0].content[0]?.type !== 'output_text' ||
      response.output[0].content[0].text !== 'N08_ORDINARY_DEFAULT_OK'
    )
      throw fail();
  }
  return { status: value.status, body: response };
}
function checkAdmissionEvidence(input) {
  const value = exact(input, [
    'enhanced',
    'ordinary',
    'enhancedPrivateDispatchDelta',
    'oldRootPrivateRequestDelta',
    'enhancedDefaultDispatchDelta',
    'ordinaryDefaultDispatchDelta',
  ]);
  const enhanced = wire(value.enhanced, false, true);
  if (enhanced.status === 200) {
    if (value.enhancedDefaultDispatchDelta !== 1) throw fail();
  } else if (
    ![403, 409, 410, 503].includes(enhanced.status) ||
    value.enhancedDefaultDispatchDelta !== 0 ||
    ![
      'context_recovery_unavailable',
      'context_recovery_authorization_changed',
      'context_recovery_disabled',
      'context_recovery_scope_unavailable',
    ].includes(enhanced.body?.error?.code)
  )
    throw fail();
  wire(value.ordinary, true);
  if (
    value.enhancedPrivateDispatchDelta !== 0 ||
    value.oldRootPrivateRequestDelta !== 0 ||
    value.ordinaryDefaultDispatchDelta !== 1
  )
    throw fail();
}
function checkWithdrawal(input, expectedOwner) {
  const identity = parseOwner(expectedOwner);
  const value = exact(input, [
    'response',
    'ownerStatus',
    'externalToolReplays',
    'oldRootPrivateRequestDelta',
    'inFlightDefaultDispatchDelta',
    'before',
    'after',
  ]);
  const status = exact(value.ownerStatus, ['pid', 'manifestSha256', 'nonce', 'alive']);
  if (
    status.alive !== true ||
    Object.entries(identity).some(([key, expected]) => status[key] !== expected)
  )
    throw fail();
  const response = wire(value.response, false, true);
  if (
    value.externalToolReplays !== 0 ||
    value.oldRootPrivateRequestDelta !== 0 ||
    value.inFlightDefaultDispatchDelta !== (response.status === 200 ? 1 : 0)
  )
    throw fail();
  const before = exact(value.before, ['rootId', 'expiresAt', 'readerCalls', 'readerBytes']);
  const after = exact(value.after, ['rootId', 'expiresAt', 'readerCalls', 'readerBytes']);
  if (
    typeof before.rootId !== 'string' ||
    !/^hbs_[a-f0-9]{32}$/.test(before.rootId) ||
    after.rootId !== before.rootId
  )
    throw fail();
  for (const snapshot of [before, after])
    for (const key of ['expiresAt', 'readerCalls', 'readerBytes'])
      if (!Number.isSafeInteger(snapshot[key]) || snapshot[key] < 0) throw fail();
  if (
    before.expiresAt < 1 ||
    after.expiresAt !== before.expiresAt ||
    after.readerCalls < before.readerCalls ||
    after.readerBytes < before.readerBytes
  )
    throw fail();
}
module.exports = {
  BARRIERS,
  MUTATIONS,
  snapshotOwnData,
  exact,
  parseOwner,
  ack,
  checkAck,
  createResponseHold,
  checkAdmissionEvidence,
  checkWithdrawal,
};
