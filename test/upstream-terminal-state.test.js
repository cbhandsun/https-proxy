const assert = require('assert');
const { createUpstreamTerminalState } = require('../lib/proxy/handlers/upstream-terminal-state');

{
  // Regression: a timeout used to be able to coexist with a later success record.
  // The first observer owns the terminal record; a late upstream 'end' must not
  // overwrite a failure with statusCode 200 for the same reqId.
  const ends = [];
  const state = createUpstreamTerminalState({
    logRequestEnd(method, path, startTime, statusCode, extra) {
      ends.push({ method, path, startTime, statusCode, extra });
    },
  });

  assert.strictEqual(state.isSettled(), false);
  assert.strictEqual(
    state.fail({
      method: 'POST',
      path: '/v1/responses',
      startTime: 1000,
      statusCode: 502,
      type: 'proxy_error',
      errorType: 'proxy_error',
      failureKind: 'upstream_timeout',
      error: 'Gateway Timeout (Upstream request timed out)',
    }),
    true
  );
  assert.strictEqual(state.isSettled(), true);
  assert.strictEqual(state.markComplete(), false, 'a late success must not settle again');
  assert.strictEqual(state.fail({ statusCode: 500 }), false, 'a second failure is ignored');

  assert.strictEqual(ends.length, 1);
  assert.strictEqual(ends[0].statusCode, 502);
  assert.strictEqual(ends[0].extra.failureKind, 'upstream_timeout');
  assert.strictEqual(ends[0].extra.errorType, 'proxy_error');
}

{
  // Happy path still emits exactly one terminal record with the upstream status.
  const ends = [];
  const state = createUpstreamTerminalState({
    logRequestEnd(_method, _path, _startTime, statusCode, extra) {
      ends.push({ statusCode, extra });
    },
  });
  assert.strictEqual(state.markComplete(), true);
  assert.strictEqual(state.fail({ method: 'POST', startTime: 1, statusCode: 502 }), false);
  assert.deepStrictEqual(ends, [], 'markComplete leaves logging to the caller');
}

{
  // Missing routing context must not throw; the caller still learns the outcome.
  const state = createUpstreamTerminalState({ logRequestEnd() {} });
  assert.strictEqual(state.fail({ statusCode: 502 }), true, 'first observer still settles');
  assert.strictEqual(state.fail({ statusCode: 502 }), false);
}

{
  // A missing logRequestEnd dependency is tolerated for isolated unit harnesses.
  const state = createUpstreamTerminalState();
  assert.strictEqual(state.fail({ method: 'POST', startTime: 1, statusCode: 502 }), true);
  assert.strictEqual(state.markComplete(), false);
  assert.strictEqual(state.reason(), 'upstream_failure');
}

{
  // Regression: the conversation-audit record is written from inside clientRes.end(),
  // which samples clientRes.statusCode. The upstream had already sent 200 headers
  // before the body timed out, so the audit log recorded a success for a request that
  // proxy-events.jsonl recorded as a 502. The failure hook lets the audit record learn
  // the real outcome, and only the first observer may report it.
  const recorded = [];
  const state = createUpstreamTerminalState({
    logRequestEnd() {},
    recordFailure: (detail) => recorded.push(detail),
  });
  assert.strictEqual(
    state.fail({ statusCode: 502, failureKind: 'upstream_timeout', error: 'Gateway Timeout' }),
    true
  );
  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].statusCode, 502);
  assert.strictEqual(recorded[0].failureKind, 'upstream_timeout');
  assert.strictEqual(state.markComplete(), false, 'a late success must not re-settle');
  assert.strictEqual(state.fail({ statusCode: 500 }), false);
  assert.strictEqual(recorded.length, 1, 'later observers must not re-record the failure');
}

{
  // A throwing audit hook must not stop the terminal record from being written.
  const ends = [];
  const state = createUpstreamTerminalState({
    logRequestEnd(_m, _p, _s, statusCode) {
      ends.push(statusCode);
    },
    recordFailure() {
      throw new Error('audit boom');
    },
  });
  assert.strictEqual(
    state.fail({ method: 'POST', path: '/v1/responses', startTime: 1, statusCode: 502 }),
    true
  );
  assert.deepStrictEqual(ends, [502]);
}

console.log('[upstream-terminal-state.test] ok');
