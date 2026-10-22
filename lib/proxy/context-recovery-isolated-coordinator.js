'use strict';

const { createContextRecoveryCoordinator } = require('./context-recovery-coordinator');
const { createContextRecoveryTurn } = require('./context-recovery-turn');
const { createRecoveryPublicGeneration } = require('./context-recovery-public-generation');
const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');
const { safeRecoveryUsage, parseRecoveryProgress } = require('./context-recovery-progress');
const { nativeReaderPromise } = require('./context-recovery-reader-result');

// Two independently constructed model conversations. No private response is a
// public candidate. External tools are advertised only to the public model and
// are never executed here. The binding owner supplies the original public
// request separately from expanded private history, plus exact public-only
// ancestry proof when the original request uses a provider continuation ID.
function createContextRecoveryIsolatedCoordinator({
  kind,
  body,
  privateBody = body,
  session,
  historyFormat = 2,
  publicPreviousResponseId,
}) {
  const methods = {};
  for (const name of ['inspect', 'reply', 'replyAsync']) {
    const field = session && Object.getOwnPropertyDescriptor(session, name);
    if (!field && name === 'replyAsync') continue;
    if (typeof field?.value !== 'function') throw new TypeError('Invalid recovery capability');
    methods[name] = field.value.bind(session);
  }
  const definitions = session && Object.getOwnPropertyDescriptor(session, 'definitions');
  if (!definitions || !Object.hasOwn(definitions, 'value'))
    throw new TypeError('Invalid recovery capability');
  const publicTurn = createContextRecoveryTurn(kind, body, definitions.value, historyFormat);
  if (!publicTurn.ok) return publicTurn;
  const projection = createRecoveryPublicGeneration(
    kind,
    body,
    historyFormat,
    publicPreviousResponseId
  );
  const privateInput = normalizeRecoveryRequestBody(kind, privateBody, historyFormat);
  let phase = 'private';
  let busy = false;
  let completed = null;
  let progress = { rounds: 0, calls: 0, usage: [] };
  function observe(name, args, result) {
    if (phase !== 'private') return result;
    projection.capture(name, args, result);
    return result;
  }
  const readers = { definitions: definitions.value, inspect: methods.inspect };
  for (const name of ['reply', 'replyAsync']) {
    if (!methods[name]) continue;
    readers[name] = (tool, args) => {
      const result = methods[name](tool, args);
      return nativeReaderPromise(result)
        ? Promise.prototype.then.call(result, (value) => observe(tool, args, value))
        : observe(tool, args, result);
    };
  }
  const privateRun = createContextRecoveryCoordinator({
    kind,
    body: { ...privateInput, tools: [] },
    session: readers,
    historyFormat,
    maxRounds: 7, // Reserve the eighth existing round for public generation.
  });
  if (!privateRun.ok) {
    projection.close();
    return privateRun;
  }
  let initialRequest = privateRun.initialRequest;
  const visible = Object.getOwnPropertyDescriptor(methods.inspect(), 'visibleSources');
  if (visible && Object.hasOwn(visible, 'value') && visible.value === 0) {
    // The bound owner has no readable evidence. No private discovery is needed
    // and no internal schema is sent: ordinary tool execution remains public.
    initialRequest = projection.request();
    projection.close();
    privateRun.cancel();
    phase = 'public';
    completed = { history: privateRun.initialRequest[kind === 'responses' ? 'input' : 'messages'] };
  }
  function live() {
    try {
      return methods.inspect().active === true;
    } catch {
      return false;
    }
  }
  function fail(code) {
    phase = 'terminal';
    projection.close();
    privateRun.cancel();
    completed = null;
    return { ok: false, mode: 'failed', code, ...parseRecoveryProgress(progress) };
  }
  function advancePrivate(result) {
    progress = parseRecoveryProgress({
      rounds: result.rounds,
      calls: result.calls,
      usage: result.usage,
    });
    if (!result.ok) return fail(result.code);
    if (!live()) return fail('context_recovery_unavailable');
    if (result.mode !== 'release') return result;
    completed = result;
    const request = projection.request();
    projection.close();
    phase = 'public';
    return { ok: true, mode: 'continue', request, ...parseRecoveryProgress(progress) };
  }
  function advancePublic(input) {
    progress.rounds++;
    const turn = publicTurn.decode(input);
    progress.usage.push(safeRecoveryUsage(turn.response.usage ?? {}));
    if (turn.calls.some((call) => call.internal))
      return fail('context_recovery_public_reader_forbidden');
    if (!live()) return fail('context_recovery_unavailable');
    phase = 'terminal';
    const history = completed.history;
    completed = null;
    return {
      ok: true,
      mode: 'release',
      response: turn.response,
      output: turn.output,
      history,
      deferredExternal: false,
      ...parseRecoveryProgress(progress),
    };
  }
  function start() {
    if (busy) return { ok: false, mode: 'failed', code: 'context_recovery_busy' };
    if (phase === 'terminal')
      return { ok: false, mode: 'failed', code: 'context_recovery_terminal' };
    if (!live()) return fail('context_recovery_unavailable');
    busy = true;
    return null;
  }
  return {
    ok: true,
    initialRequest,
    inspectProgress() {
      return phase === 'private' ? privateRun.inspectProgress() : parseRecoveryProgress(progress);
    },
    accept(input) {
      const stopped = start();
      if (stopped) return stopped;
      try {
        return phase === 'private'
          ? advancePrivate(privateRun.accept(input))
          : advancePublic(input);
      } catch {
        return fail('context_recovery_invalid_turn');
      } finally {
        busy = false;
      }
    },
    async acceptAsync(input) {
      const stopped = start();
      if (stopped) return stopped;
      try {
        const result = phase === 'private' ? await privateRun.acceptAsync(input) : null;
        if (phase === 'terminal') return fail('context_recovery_cancelled');
        return phase === 'private' ? advancePrivate(result) : advancePublic(input);
      } catch {
        return fail('context_recovery_invalid_turn');
      } finally {
        busy = false;
      }
    },
    cancel() {
      if (phase === 'private') progress = privateRun.inspectProgress();
      return fail('context_recovery_cancelled');
    },
  };
}

module.exports = { createContextRecoveryIsolatedCoordinator };
