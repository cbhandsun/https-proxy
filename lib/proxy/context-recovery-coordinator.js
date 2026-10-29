'use strict';

const { createContextRecoveryTurn } = require('./context-recovery-turn');
const { normalizeCompactionData } = require('./context-compaction-envelope');
const { fingerprintContextData } = require('./context-recovery-fingerprint');
const {
  safeRecoveryUsage: safeUsage,
  parseRecoveryProgress,
} = require('./context-recovery-progress');
const {
  nativeReaderPromise,
  contextRecoveryReaderResult,
  rejectAsyncReaderResult,
} = require('./context-recovery-reader-result');

const MAX_ROUNDS = 8;
const MAX_CALLS = 64;

// Request-local state machine. It returns a bounded next request to its caller;
// it owns no network client or external executor. No client bytes may be released
// until mode=release. The caller must commit the returned history mapping before
// claiming cross-request continuity, and account every entry in usage.
function createContextRecoveryCoordinator({
  kind,
  body,
  session,
  deferMixedResults = false,
  historyFormat = 2,
  maxRounds = MAX_ROUNDS,
}) {
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS)
    throw new TypeError('Invalid recovery round budget');
  if (typeof deferMixedResults !== 'boolean' || (deferMixedResults && kind !== 'responses'))
    throw new TypeError('Invalid recovery mixed-turn capability');
  const methods = {};
  for (const name of ['inspect', 'reply']) {
    const descriptor = session && Object.getOwnPropertyDescriptor(session, name);
    if (typeof descriptor?.value !== 'function') throw new TypeError('Invalid recovery capability');
    methods[name] = descriptor.value.bind(session);
  }
  const asyncReply = session && Object.getOwnPropertyDescriptor(session, 'replyAsync');
  if (asyncReply) {
    if (typeof asyncReply.value !== 'function') throw new TypeError('Invalid recovery capability');
    methods.replyAsync = asyncReply.value.bind(session);
  }
  const definitions = Object.getOwnPropertyDescriptor(session, 'definitions');
  if (!definitions || !Object.hasOwn(definitions, 'value'))
    throw new TypeError('Invalid recovery capability');
  const adapter = createContextRecoveryTurn(kind, body, definitions.value, historyFormat);
  if (!adapter.ok) return adapter;
  let history = adapter.history;
  let pending = null;
  let rounds = 0;
  let calls = 0;
  let terminal = false;
  let accepting = false;
  let publicOutputReferences = [];
  let retainedHistory = null;
  const usage = [];
  const seen = new Set();
  function fail(code) {
    terminal = true;
    history = [];
    pending = null;
    retainedHistory = null;
    publicOutputReferences = [];
    return {
      mode: 'failed',
      ok: false,
      code,
      rounds,
      calls,
      usage: normalizeCompactionData(usage, 128 * 1024),
    };
  }
  function live() {
    try {
      return methods.inspect().active === true;
    } catch {
      return false;
    }
  }
  function* advance(input) {
    if (terminal) return { mode: 'failed', ok: false, code: 'context_recovery_terminal' };
    if (!live()) return fail('context_recovery_unavailable');
    if (rounds >= maxRounds) return fail('context_recovery_round_limit');
    rounds++;
    try {
      const turn = adapter.decode(input, pending !== null);
      const measured = safeUsage(turn.response.usage ?? {});
      usage.push(measured);
      const internal = turn.calls.filter((call) => call.internal);
      const external = turn.calls.filter((call) => !call.internal);
      const hosted =
        kind === 'responses' && turn.output.some((item) => item.type === 'web_search_call');
      const mixed = external.length > 0 || hosted;
      if (!internal.length) {
        if (pending && turn.calls.length) return fail('context_recovery_invalid_turn');
        const response = pending?.response ?? turn.response;
        terminal = true;
        return {
          ok: true,
          mode: 'release',
          response,
          output: pending?.output ?? turn.output,
          history: retainedHistory ?? history,
          usage,
          rounds,
          calls,
          deferredExternal: pending !== null,
          ...(publicOutputReferences.length ? { publicOutputReferences } : {}),
        };
      }
      // Keep opaque reasoning blocks intact. Do not split a signed mixed turn
      // until its provider adapter has a verified rewrite contract.
      if (mixed && !adapter.canSplit(turn)) return fail('context_recovery_opaque_mixed_turn');
      if (calls + internal.length > MAX_CALLS || rounds === maxRounds)
        return fail('context_recovery_round_limit');
      const keys = internal.map((call) => fingerprintContextData([call.name, call.arguments]));
      if (keys.some((key, index) => seen.has(key) || keys.indexOf(key) !== index))
        return fail('context_recovery_loop');
      const ownedTurn = mixed ? adapter.select(turn, true) : turn;
      if (mixed) {
        pending = adapter.select(turn, false);
        if (hosted)
          publicOutputReferences = adapter.publicReferences(turn).map((reference) => ({
            ...reference,
            historyIndex: history.length + reference.historyIndex,
          }));
      }
      const results = [];
      for (let index = 0; index < internal.length; index++) {
        if (!live()) return fail('context_recovery_unavailable');
        const call = internal[index];
        seen.add(keys[index]);
        calls++;
        const reply = yield call;
        if (terminal) return fail('context_recovery_cancelled');
        if (!live()) return fail('context_recovery_unavailable');
        results.push({ id: call.id, ok: reply.ok === true, text: reply.text });
      }
      if (!live()) return fail('context_recovery_unavailable');
      if (hosted) retainedHistory = adapter.append(history, turn, results);
      else if (retainedHistory)
        retainedHistory = adapter.append(retainedHistory, ownedTurn, results);
      history = adapter.append(history, ownedTurn, results);
      if (pending && deferMixedResults) {
        // WS store:false may no longer have an older mixed response after an
        // extra model round. Keep its real ID current, publish only the external
        // calls, and join completed private results to the next client results.
        terminal = true;
        return {
          ok: true,
          mode: 'release',
          response: pending.response,
          output: pending.output,
          history: retainedHistory ?? history,
          usage,
          rounds,
          calls,
          deferredExternal: true,
          deferredInput: results.map((result) => ({
            type: 'function_call_output',
            call_id: result.id,
            output: result.text,
          })),
          ...(publicOutputReferences.length ? { publicOutputReferences } : {}),
        };
      }
      return {
        ok: true,
        mode: 'continue',
        request: adapter.request(history, pending !== null),
        rounds,
        calls,
        usage: normalizeCompactionData(usage, 128 * 1024),
      };
    } catch {
      return fail('context_recovery_invalid_turn');
    }
  }
  const unavailable = () => fail('context_recovery_unavailable');
  const busy = () => ({ mode: 'failed', ok: false, code: 'context_recovery_busy' });
  return {
    ok: true,
    initialRequest: adapter.request(history),
    inspectProgress() {
      return parseRecoveryProgress({ rounds, calls, usage });
    },
    accept(input) {
      if (accepting) return busy();
      accepting = true;
      const iterator = advance(input);
      try {
        let step = iterator.next();
        while (!step.done) {
          const reply = methods.reply(step.value.name, step.value.arguments);
          rejectAsyncReaderResult(reply);
          step = iterator.next(contextRecoveryReaderResult(reply));
        }
        return step.value;
      } catch {
        return unavailable();
      } finally {
        iterator.return();
        accepting = false;
      }
    },
    async acceptAsync(input) {
      if (accepting) return busy();
      accepting = true;
      const iterator = advance(input);
      try {
        let step = iterator.next();
        while (!step.done) {
          const reply = (methods.replyAsync ?? methods.reply)(
            step.value.name,
            step.value.arguments
          );
          // Do not await an arbitrary result: doing so executes its .then getter.
          const result = nativeReaderPromise(reply) ? await reply : reply;
          step = iterator.next(contextRecoveryReaderResult(result));
        }
        return step.value;
      } catch {
        return unavailable();
      } finally {
        iterator.return();
        accepting = false;
      }
    },
    cancel() {
      return fail('context_recovery_cancelled');
    },
  };
}

module.exports = { createContextRecoveryCoordinator };
