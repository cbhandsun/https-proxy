'use strict';
const { dataSnapshot } = require('./context-recovery-daemon-http-boundary');
const { syntheticCodexWire } = require('./nsis-client-codex-upstream-wire');
const { claudeSyntheticSse } = require('./nsis-client-claude-upstream-wire');
const fail = () => new Error('installed_http_drain_failed');
const TEXT = 'HPM_INSTALLED_HTTP_DRAIN_OK';
const INPUT = 'HPM_INSTALLED_HTTP_DRAIN_REQUEST';
function parseDrainOptions(input) {
  try {
    const value = dataSnapshot(input, 'installed_http_drain_failed');
    if (
      Object.keys(value).sort().join(',') !== 'client,entryToken,mode,model,upstreamToken' ||
      !['codex', 'claude'].includes(value.client) ||
      !['default', 'enhanced'].includes(value.mode) ||
      value.model !== 'hpm-installed-' + value.client ||
      typeof value.entryToken !== 'string' ||
      !/^hpm-synthetic-[a-f0-9]{32}$/.test(value.entryToken) ||
      typeof value.upstreamToken !== 'string' ||
      !/^hpm-upstream-[a-f0-9]{32}$/.test(value.upstreamToken)
    )
      throw fail();
    return value;
  } catch {
    throw fail();
  }
}

function publicReply(client, model) {
  return client === 'codex'
    ? {
        id: 'resp_hpm_installed_drain',
        object: 'response',
        status: 'completed',
        model,
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: TEXT }] },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }
    : {
        id: 'msg_hpm_installed_drain',
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: TEXT }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
}

function drainPlan(options, stream) {
  const expected = publicReply(options.client, options.model);
  const reply = stream
    ? options.client === 'codex'
      ? syntheticCodexWire({ model: options.model, sequence: 913, text: TEXT, stream: true })
      : claudeSyntheticSse(options.model, 913, [{ type: 'text', text: TEXT }])
    : {
        statusCode: 200,
        contentType: 'application/json; charset=utf-8',
        wire: Buffer.from(JSON.stringify(expected)),
      };
  const split = stream ? reply.wire.indexOf(Buffer.from('\n\n')) + 2 : 0;
  if (stream && (split < 3 || split >= reply.wire.length)) throw fail();
  return {
    stream,
    expected,
    reply,
    split,
    body: Buffer.from(
      JSON.stringify(
        options.client === 'codex'
          ? { model: options.model, input: [{ role: 'user', content: INPUT }], stream }
          : {
              model: options.model,
              messages: [{ role: 'user', content: INPUT }],
              max_tokens: 32,
              stream,
            }
      )
    ),
  };
}
module.exports = { parseDrainOptions, drainPlan, INPUT };
