'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  attachConversionStreamCleanup,
} = require('../lib/proxy/handlers/conversion-stream-cleanup');
const { harness } = require('./internal-stream-events.test');
for (const event of ['close', 'error', 'finish']) {
  const client = new EventEmitter();
  let cleared = 0;
  const converter = {
    state: { done: true, finished: false },
    dispose: () => {
      cleared++;
    },
  };
  attachConversionStreamCleanup(client, converter);
  client.emit(event);
  assert.equal(cleared, 1);
  assert.equal(client.listenerCount('close'), 0);
  assert.equal(client.listenerCount('error'), 0);
  assert.equal(client.listenerCount('finish'), 0);
}
const completedClient = new EventEmitter();
attachConversionStreamCleanup(completedClient, {
  state: { done: true, finished: true },
  dispose: () => assert.fail('completed stream disposed'),
});
completedClient.emit('finish');
const frame = (type, value) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n';
for (const kind of ['chat', 'responses']) {
  const h = harness(false);
  const options = { id: 'msg', model: 'fixture', writeEvent: h.stream.writeClaudeSseEvent };
  const converter =
    h.protocol[kind === 'chat' ? 'createChatClaudeStream' : 'createResponsesClaudeStream'](options);
  converter.start(h.sink);
  const argumentsText = '{"q":"SECRET"}';
  const input =
    kind === 'chat'
      ? 'data: ' +
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'a',
                    type: 'function',
                    function: { name: 'lookup', arguments: argumentsText },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }) +
        '\n\n'
      : frame('response.output_item.done', {
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'item',
            call_id: 'a',
            name: 'lookup',
            arguments: argumentsText,
          },
        }) + frame('response.completed', { response: { status: 'completed' } });
  converter.processChunk(h.sink, input);
  assert.ok(!h.writes.join('').includes('"type":"tool_use"'));
  const client = new EventEmitter();
  attachConversionStreamCleanup(client, converter);
  client.emit('close');
  assert.equal(converter.state.disposed, true);
  assert.equal(converter.state.buffer, '');
  assert.equal(converter.finish(h.sink), false);
  assert.ok(!h.writes.join('').includes('SECRET'));
  assert.ok(!h.writes.join('').includes('"type":"tool_use"'));
}
process.stdout.write('[conversion-stream-cleanup.test] ok\n');
