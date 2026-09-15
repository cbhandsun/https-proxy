'use strict';

const assert = require('node:assert/strict');
const {
  createUpstreamTerminalFrameWatcher,
  DEFAULT_TERMINAL_MARKERS,
} = require('../lib/proxy/handlers/upstream-terminal-frame');

// Regression: official Responses upstreams send response.completed and then hold the
// socket open. Without terminal-frame detection the proxy waited for close, so a
// complete answer sat until profile.timeoutMs and was then reported as a 502.
{
  const hits = [];
  const watcher = createUpstreamTerminalFrameWatcher({ onTerminal: (m) => hits.push(m) });
  const frame =
    'data: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n';
  const first = watcher.push(frame);
  assert.ok(first, 'the completed frame must be detected');
  assert.equal(hits.length, 1);
  assert.equal(watcher.isSettled(), true);
  assert.equal(watcher.matchedMarker(), first);

  // Only the first terminal frame settles; later frames must not re-fire.
  assert.equal(watcher.push('data: {"type":"response.completed"}\n\n'), null);
  assert.equal(hits.length, 1);
}

// SSE frames arrive split across arbitrary TCP chunks; a half line must be buffered
// rather than missed.
{
  const hits = [];
  const watcher = createUpstreamTerminalFrameWatcher({ onTerminal: (m) => hits.push(m) });
  assert.equal(
    watcher.push('data: {"type":"response.comp'),
    null,
    'partial line is not a match yet'
  );
  assert.equal(watcher.isSettled(), false);
  assert.ok(watcher.push('leted","response":{}}\n'), 'completion spans two chunks');
  assert.equal(hits.length, 1);
}

// Multi-byte UTF-8 can straddle chunks too; the decoder must not corrupt the line.
{
  const hits = [];
  const watcher = createUpstreamTerminalFrameWatcher({ onTerminal: (m) => hits.push(m) });
  const payload = Buffer.from(
    'data: {"type":"response.output_text.delta","delta":"你好"}\n',
    'utf8'
  );
  const split = payload.indexOf(Buffer.from('你', 'utf8')) + 1;
  assert.equal(watcher.push(payload.subarray(0, split)), null);
  assert.equal(watcher.push(payload.subarray(split)), null, 'a delta frame is not terminal');
  assert.ok(watcher.push(Buffer.from('data: [DONE]\n', 'utf8')));
  assert.equal(hits[0], '[DONE]');
}

// A pretty-printed JSON body can contain the literal marker on its own line. Only SSE
// lines may match, otherwise a non-streaming response would be truncated.
{
  const hits = [];
  const watcher = createUpstreamTerminalFrameWatcher({ onTerminal: (m) => hits.push(m) });
  const jsonBody = '{\n  "type": "response.completed",\n  "response": {}\n}';
  assert.equal(watcher.push(jsonBody), null, 'JSON must not be treated as a terminal SSE frame');
  assert.equal(watcher.isSettled(), false);
  assert.deepEqual(hits, []);
}

// Equivalent spellings and other providers' terminal events must all be recognised.
{
  const cases = [
    ['data: {"type": "response.completed"}\n', 'response.completed spaced'],
    ['data: {"type":"response.incomplete"}\n', 'response.incomplete'],
    ['data: {"type":"response.failed"}\n', 'response.failed'],
    ['data: [DONE]\n', '[DONE]'],
    ['event: message_stop\n', 'claude message_stop'],
  ];
  for (const [frame, label] of cases) {
    const watcher = createUpstreamTerminalFrameWatcher({});
    assert.ok(watcher.push(frame), label + ' must be detected');
  }
  assert.ok(DEFAULT_TERMINAL_MARKERS.length > 0);
}

// A watcher without a callback must still report the match without throwing.
{
  const watcher = createUpstreamTerminalFrameWatcher();
  assert.ok(watcher.push('data: {"type":"response.completed"}\n'));
  assert.equal(watcher.isSettled(), true);
}

// Empty and falsy chunks are tolerated.
{
  const watcher = createUpstreamTerminalFrameWatcher({});
  assert.equal(watcher.push(null), null);
  assert.equal(watcher.push(''), null);
  assert.equal(watcher.push(undefined), null);
  assert.equal(watcher.isSettled(), false);
}

// Custom markers replace the defaults (used by callers with a different contract).
{
  const hits = [];
  const watcher = createUpstreamTerminalFrameWatcher({
    markers: ['"type":"custom.done"'],
    onTerminal: (m) => hits.push(m),
  });
  assert.equal(watcher.push('data: {"type":"response.completed"}\n'), null);
  assert.ok(watcher.push('data: {"type":"custom.done"}\n'));
  assert.deepEqual(hits, ['"type":"custom.done"']);
}

console.log('[upstream-terminal-frame.test] ok');
