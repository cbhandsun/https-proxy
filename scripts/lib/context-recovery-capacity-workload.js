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

function readPinned(session, pinned, expected) {
  const chunks = [];
  let offsetBytes = 0;
  for (;;) {
    const reply = session.reply(READ, {
      sourceId: pinned.sourceId,
      digest: pinned.digest,
      offsetBytes,
    });
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

// Exercises actual session/binding/ledger APIs with a synthetic clock. No
// transport, compaction, filesystem, credentials or model requests are involved.
// Reopen means JSON checkpoint reconstruction, not durable SQLite qualification.
function exerciseCapacityProfile(input) {
  const profile = parseProfile(input);
  let time = 1000;
  let runtime = createContextRecoverySessions({ now: () => time });
  runtime.configure(true);
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
  function observe(owner, round, index) {
    const session = runtime.begin({ ...owner.binding, history: owner.history }, owner.results);
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
      session.abort();
      return null;
    }
    return session;
  }
  try {
    outer: for (let round = 0; round < profile.turns; round++) {
      time = 1000 + round * profile.intervalMs;
      for (const [index, owner] of owners.entries()) {
        const session = observe(owner, round + 1, index);
        if (!session) break outer;
        // Exact number of recoveries, including the final drain. This avoids
        // rounding a requested 100 recoveries down to a convenient small count.
        if (
          round > 0 &&
          Math.floor((round * profile.recoveries) / profile.turns) >
            Math.floor(((round - 1) * profile.recoveries) / profile.turns)
        )
          recover(owner, session, round + 1, index);
        const callId = 'call-' + index + '-' + round;
        const tool = {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: callId, type: 'function', function: { name: 'lookup', arguments: '{}' } },
          ],
        };
        const result = session.complete(
          [tool],
          [{ callId, toolName: 'lookup', arguments: {}, completed: true, output: '' }],
          'response-' + index + '-' + round
        );
        if (!result.ok) {
          report.firstFailure ??= {
            phase: 'complete',
            round: round + 1,
            root: index,
            code: result.code,
          };
          session.abort();
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
        const states = owners.map((owner) => ({
          binding: owner.binding,
          state: exportContextRecoveryRoot(runtime, owner.rootId),
        }));
        runtime.close();
        runtime = restoreContextRecoverySessions(
          { now: () => time },
          JSON.parse(JSON.stringify(states))
        );
        report.reopenCount++;
      }
    }
    if (!report.firstFailure) {
      // Completing the last call does not capture its result. Drain it through
      // a real next request before declaring any full-workload success.
      let drained = 0;
      for (const [index, owner] of owners.entries()) {
        const session = observe(owner, profile.turns + 1, index);
        if (!session) break;
        if (profile.recoveries) recover(owner, session, profile.turns + 1, index);
        drained++;
        session.abort();
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
    runtime.close();
  }
  function recover(owner, session, round, index) {
    const listed = session.reply(LIST, {});
    if (!listed.ok) {
      report.firstReadFailure ??= { phase: 'list', round, root: index, code: listed.code };
      return;
    }
    owner.pinned ??= JSON.parse(listed.text).sources[0];
    const code = owner.pinned
      ? readPinned(session, owner.pinned, owner.original)
      : 'missing_source';
    if (code) report.firstReadFailure ??= { phase: 'read', round, root: index, code };
    else report.verifiedRecoveries++;
  }
}

module.exports = { CAPACITY_PROFILES, parseProfile, exerciseCapacityProfile };
