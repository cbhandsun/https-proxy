'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const {
  createContextRecoverySessions,
  exportContextRecoveryRoot,
  restoreContextRecoverySessions,
} = require('../../lib/proxy/context-recovery-sessions');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../../lib/proxy/context-evidence-tools');

// Version this workload independently of implementation limits. Passing a
// smaller fixture is never qualification for these frozen engineering targets.
const CAPACITY_PROFILES = Object.freeze(
  [
    ['day-small', 1, 288, 300000, 1024, 24, 24],
    ['active-small', 1, 480, 60000, 1024, 32, 30],
    ['four-tasks-small', 4, 96, 300000, 512, 24, 8],
    ['frequent-recovery', 1, 96, 300000, 512, 24, 96],
    ['four-tasks-candidate', 4, 480, 60000, 32768, 24, 100],
  ].map(([name, roots, turns, intervalMs, outputBytes, reopenEvery, recoveries]) =>
    Object.freeze({ name, roots, turns, intervalMs, outputBytes, reopenEvery, recoveries })
  )
);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const user = (content) => ({ role: 'user', content });

function parseProfile(input) {
  try {
    const value = normalizeCompactionData(input, 2048);
    if (
      !value ||
      Object.keys(value).sort().join(',') !==
        'intervalMs,name,outputBytes,recoveries,reopenEvery,roots,turns' ||
      typeof value.name !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(value.name)
    )
      throw new Error();
    for (const [key, minimum, maximum] of [
      ['roots', 1, 4],
      ['turns', 1, 480],
      ['intervalMs', 1, 300000],
      ['outputBytes', 0, 2 * 1024 * 1024],
      ['reopenEvery', 0, 480],
      ['recoveries', 0, value.turns],
    ]) {
      if (!Number.isSafeInteger(value[key]) || value[key] < minimum || value[key] > maximum)
        throw new Error();
    }
    if (value.turns * value.intervalMs > 86400000) throw new Error();
    return value;
  } catch {
    throw new TypeError('invalid_capacity_profile');
  }
}

function* readPinned(session, pinned, expected) {
  const chunks = [];
  let offsetBytes = 0;
  for (;;) {
    const reply = yield {
      operation: 'reply',
      session,
      name: READ,
      args: { sourceId: pinned.sourceId, digest: pinned.digest, offsetBytes },
    };
    if (!reply.ok) return reply.code;
    const { page } = JSON.parse(reply.text);
    assert.equal(page.offsetBytes, offsetBytes);
    assert.equal(page.digest, sha(expected));
    assert.equal(page.chunkDigest, sha(page.text));
    chunks.push(page.text);
    if (page.nextOffsetBytes === null) break;
    assert.ok(page.nextOffsetBytes > offsetBytes);
    offsetBytes = page.nextOffsetBytes;
  }
  assert.equal(chunks.join(''), expected);
  return null;
}

// A single command sequence defines the frozen workload for both synchronous
// in-memory reconstruction and asynchronous durable storage. The executor owns
// the clock and resources; it cannot shorten turns, reads, pages or reopenings.
function* createCapacityWorkload(input) {
  const profile = parseProfile(input);
  const owners = Array.from({ length: profile.roots }, (_, index) => {
    const history = [user('synthetic-capacity-' + index)];
    return {
      binding: {
        principal: 'capacity-owner',
        protocol: 'chat',
        target: 'capacity-target',
        history,
      },
      history,
      results: [],
      completed: 0,
      pinned: null,
      original: '0'.repeat(profile.outputBytes),
    };
  });
  const report = {
    profile,
    completedTurns: 0,
    verifiedRecoveries: 0,
    reopenCount: 0,
    finalResultsObserved: false,
    firstCoverageGap: null,
    firstReadFailure: null,
    firstFailure: null,
    qualified: false,
  };
  function* observe(owner, round, index) {
    const session = yield {
      operation: 'begin',
      binding: { ...owner.binding, history: owner.history },
      results: owner.results,
    };
    if (!session.ok) {
      report.firstFailure ??= { phase: 'begin', round, root: index, code: session.code };
      return null;
    }
    owner.rootId ??= session.snapshotId;
    const available = session.inspect().visibleSources;
    if (available !== owner.completed) {
      report.firstCoverageGap ??= {
        round,
        root: index,
        expectedSources: owner.completed,
        availableSources: available,
      };
      // The fixed target has already failed. Preserve the exact first gap and
      // stop scheduling further mutations; never shorten a successful profile.
      yield { operation: 'abort', session };
      return null;
    }
    return session;
  }
  try {
    yield { operation: 'open' };
    outer: for (let round = 0; round < profile.turns; round++) {
      yield { operation: 'advance', offsetMs: round * profile.intervalMs };
      for (const [index, owner] of owners.entries()) {
        const session = yield* observe(owner, round + 1, index);
        if (!session) break outer;
        // Exact number of recoveries, including the final drain. This avoids
        // rounding a requested 100 recoveries down to a convenient small count.
        if (
          round > 0 &&
          Math.floor((round * profile.recoveries) / profile.turns) >
            Math.floor(((round - 1) * profile.recoveries) / profile.turns)
        )
          yield* recover(owner, session, round + 1, index);
        const callId = 'call-' + index + '-' + round;
        const tool = {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: callId, type: 'function', function: { name: 'lookup', arguments: '{}' } },
          ],
        };
        const result = yield {
          operation: 'complete',
          session,
          output: [tool],
          calls: [{ callId, toolName: 'lookup', arguments: {}, completed: true, output: '' }],
          responseId: 'response-' + index + '-' + round,
        };
        if (!result.ok) {
          report.firstFailure ??= {
            phase: 'complete',
            round: round + 1,
            root: index,
            code: result.code,
          };
          yield { operation: 'abort', session };
          break outer;
        }
        const output = String(round % 10).repeat(profile.outputBytes);
        owner.history = [
          ...owner.history,
          tool,
          { role: 'tool', tool_call_id: callId, content: output },
          user('continue'),
        ];
        owner.results = [{ callId, output }];
        owner.completed++;
        report.completedTurns++;
      }
      if (profile.reopenEvery && (round + 1) % profile.reopenEvery === 0) {
        yield {
          operation: 'reopen',
          roots: owners.map((owner) => ({ binding: owner.binding, rootId: owner.rootId })),
        };
        report.reopenCount++;
      }
    }
    if (!report.firstFailure) {
      // Completing the last call does not capture its result. Drain it through
      // a real next request before declaring any full-workload success.
      let drained = 0;
      for (const [index, owner] of owners.entries()) {
        const session = yield* observe(owner, profile.turns + 1, index);
        if (!session) break;
        if (profile.recoveries) yield* recover(owner, session, profile.turns + 1, index);
        drained++;
        yield { operation: 'abort', session };
      }
      report.finalResultsObserved = drained === profile.roots;
    }
    report.qualified =
      report.completedTurns === profile.roots * profile.turns &&
      report.finalResultsObserved &&
      report.verifiedRecoveries === profile.roots * profile.recoveries &&
      !report.firstCoverageGap &&
      !report.firstReadFailure &&
      !report.firstFailure;
    return report;
  } finally {
    yield { operation: 'close' };
  }
  function* recover(owner, session, round, index) {
    const listed = yield { operation: 'reply', session, name: LIST, args: {} };
    if (!listed.ok) {
      report.firstReadFailure ??= { phase: 'list', round, root: index, code: listed.code };
      return;
    }
    owner.pinned ??= JSON.parse(listed.text).sources[0];
    const code = owner.pinned
      ? yield* readPinned(session, owner.pinned, owner.original)
      : 'missing_source';
    if (code) report.firstReadFailure ??= { phase: 'read', round, root: index, code };
    else report.verifiedRecoveries++;
  }
}

// Preserve the existing synthetic qualification, including its original JSON
// checkpoint reconstruction. Durable execution uses a separate explicit driver.
function exerciseCapacityProfile(input) {
  let time = 1000;
  let runtime;
  function execute(command) {
    switch (command.operation) {
      case 'open':
        runtime = createContextRecoverySessions({ now: () => time });
        runtime.configure(true);
        return;
      case 'advance':
        time = 1000 + command.offsetMs;
        return;
      case 'begin':
        return runtime.begin(command.binding, command.results);
      case 'reply':
        return command.session.reply(command.name, command.args);
      case 'complete':
        return command.session.complete(command.output, command.calls, command.responseId);
      case 'abort':
        return command.session.abort();
      case 'reopen': {
        const states = command.roots.map(({ binding, rootId }) => ({
          binding,
          state: exportContextRecoveryRoot(runtime, rootId),
        }));
        runtime.close();
        runtime = restoreContextRecoverySessions(
          { now: () => time },
          JSON.parse(JSON.stringify(states))
        );
        return;
      }
      case 'close':
        runtime?.close();
        return;
      default:
        throw new Error('invalid_capacity_operation');
    }
  }
  const workload = createCapacityWorkload(input);
  let reply;
  let failed = false;
  for (;;) {
    const step = failed ? workload.throw(reply) : workload.next(reply);
    if (step.done) return step.value;
    try {
      reply = execute(step.value);
      failed = false;
    } catch (error) {
      reply = error;
      failed = true;
    }
  }
}

module.exports = {
  CAPACITY_PROFILES,
  parseProfile,
  createCapacityWorkload,
  exerciseCapacityProfile,
};
