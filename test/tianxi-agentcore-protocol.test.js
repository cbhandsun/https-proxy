'use strict';

const assert = require('node:assert/strict');
const {
  DEFAULT_TIANXI_AGENT_ID,
  DEFAULT_TIANXI_CHANNEL_NAME,
  DEFAULT_TIANXI_QODER_MODEL,
  buildTianxiAgentCoreFrames,
  buildTianxiNativeApiQueryFrame,
  extractTianxiPromptText,
  parseTianxiAgentCoreNotify,
} = require('../lib/proxy/tianxi-agentcore-protocol');

assert.equal(extractTianxiPromptText('hello'), 'hello');
assert.equal(
  extractTianxiPromptText([
    { role: 'system', content: [{ type: 'input_text', text: 'ignore-system-for-prompt' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'first' }] },
    { role: 'user', content: [{ type: 'text', text: 'second' }] },
  ]),
  'second'
);
assert.equal(
  extractTianxiPromptText([
    { role: 'user', content: [{ type: 'input_text', text: '', content: 'SECRET' }] },
    { role: 'user', content: '', output: 'SECRET output' },
    { role: 'user', type: 'function_call_output', output: 'SECRET output', content: 'SECRET tool' },
    { type: 'custom_tool_call_output', output: 'SECRET custom output' },
  ]),
  ''
);
assert.equal(
  extractTianxiPromptText([
    { type: 'function_call', name: 'Read', arguments: '{"path":"SECRET"}' },
    { type: 'function_call_output', output: 'SECRET tool output' },
    { role: 'user', content: [{ type: 'input_text', text: 'continue audit' }] },
  ]),
  'continue audit'
);

const built = buildTianxiAgentCoreFrames(
  {
    model: 'super',
    instructions: 'system context',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'write this' }] }],
    metadata: {
      tianxi: {
        user_id: 'user-1',
        device_id: 'device-1',
        app_id: 'app-1',
        credentials: { type: 'official-login' },
        role: 'user',
        channel: 'agentCore',
        llm: 'cloud',
        nickname: 'tester',
        selected_pkb_files: [{ id: 'kb1' }],
      },
    },
  },
  {
    now: () => 123,
    uuid: (() => {
      const values = ['session-1', 'request-1', 'sync-1', 'query-1'];
      return () => values.shift();
    })(),
  }
);

assert.equal(built.sessionId, 'session-1');
assert.equal(built.requestId, 'request-1');
assert.equal(built.frames.length, 2);
assert.equal(built.frames[0].type, 'mcp_server_sync');
assert.equal(built.frames[0].header.session_id, 'session-1');
assert.equal(built.frames[0].header.user_id, 'user-1');
assert.equal(built.frames[0].header.device_id, 'device-1');
assert.equal(built.frames[0].header.app_id, 'app-1');
assert.deepEqual(built.frames[0].header.credentials, { type: 'official-login' });
assert.equal(built.frames[0].header.role, 'user');
assert.equal(built.frames[1].type, 'query');
assert.equal(built.frames[1].data.text, 'write this');
assert.equal(built.frames[1].data.options.model, 'cloud');
assert.equal(built.frames[1].data.options.agentcore_backend, 'qoder');
assert.equal(built.frames[1].source.id, 'user-1');
assert.equal(built.frames[1].target.id, DEFAULT_TIANXI_AGENT_ID);
assert.equal(built.frames[1].extend.channel, 'agentCore');
assert.equal(built.frames[1].extend.gateway_channel, 'agentCore');
assert.equal(built.frames[1].extend.gatewayChannel, 'agentCore');
assert.equal(built.frames[1].extend.llm, 'cloud');
assert.equal(built.frames[1].extend.raw_query, 'write this');
assert.equal(built.frames[1].extend.custom_context, 'system context');
assert.deepEqual(built.frames[1].extend.selected_pkb_files, [{ id: 'kb1' }]);

const channel = buildTianxiNativeApiQueryFrame(
  {
    model: 'super',
    instructions: 'context',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'channel prompt' }] }],
    metadata: { tianxi: { agent_id: 'super' } },
  },
  {
    now: () => 456,
    uuid: (() => {
      const values = ['channel-session', 'channel-request', 'channel-query'];
      return () => values.shift();
    })(),
  }
);
assert.equal(channel.channelName, DEFAULT_TIANXI_CHANNEL_NAME);
assert.equal(channel.frame.type, 'query');
assert.equal(channel.frame.header.session_id, 'channel-session');
assert.equal(channel.frame.header.user_id, undefined);
assert.equal(channel.frame.header.device_id, undefined);
assert.equal(channel.frame.data.text, 'channel prompt');
assert.equal(channel.frame.data.fromChannel, true);
assert.equal(channel.frame.data.options.model, DEFAULT_TIANXI_QODER_MODEL);
for (const override of [{}, { llm: 'explicit-llm' }, { model: 'explicit-model' }]) {
  const chat = buildTianxiNativeApiQueryFrame({
    model: 'chat',
    input: 'ping',
    metadata: { tianxi: { agent_id: 'chat', ...override } },
  });
  assert.equal(
    chat.frame.data.options.model,
    override.model || override.llm || DEFAULT_TIANXI_QODER_MODEL
  );
}
assert.equal(
  buildTianxiNativeApiQueryFrame({
    model: 'custom-model',
    input: 'ping',
    metadata: { tianxi: { agent_id: 'chat' } },
  }).frame.data.options.model,
  'custom-model'
);
assert.equal(channel.frame.data.options.cwd, 'C:\\Users\\juhon\\Tianxi');
assert.equal(channel.frame.data.options.permissionMode, 'bypassPermissions');
assert.equal(channel.frame.extend.channel, 'agentCore');
assert.equal(channel.frame.extend.gateway_channel, 'agentCore');
assert.equal(channel.frame.extend.gatewayChannel, 'agentCore');
assert.equal(channel.frame.extend.raw_query, 'channel prompt');
assert.equal(channel.frame.extend.workMode, 'super');
assert.equal(channel.frame.extend.custom_context, 'context');

const longPrompt = 'x'.repeat(12000);
const longChannel = buildTianxiNativeApiQueryFrame(
  {
    model: 'super',
    input: longPrompt,
    metadata: { tianxi: { agent_id: 'super' } },
  },
  {
    now: () => 789,
    uuid: (() => {
      const values = ['long-session', 'long-request', 'long-query'];
      return () => values.shift();
    })(),
  }
);
assert.equal(longChannel.frame.data.text, longPrompt);
assert.equal(longChannel.frame.data.display_text.length, 4096);
assert.equal(longChannel.frame.extend.raw_query.length, 4096);
assert.ok(
  Buffer.byteLength(JSON.stringify(longChannel.frame)) < Buffer.byteLength(longPrompt) * 2,
  'long native query frames should not duplicate the full prompt into preview fields'
);

const parsed = parseTianxiAgentCoreNotify({
  data: JSON.stringify({
    type: 'task_output',
    data: { content: 'ok' },
  }),
});
assert.equal(parsed[0].type, 'task_output');
assert.equal(parsed[0].data.content, 'ok');

const wrappedNotify = parseTianxiAgentCoreNotify({
  type: 'notify',
  data: {
    type: 'task_output',
    data: { content: 'wrapped ok' },
  },
});
assert.deepEqual(wrappedNotify, [{ type: 'task_output', data: { content: 'wrapped ok' } }]);

const stringWrappedNotify = parseTianxiAgentCoreNotify(
  JSON.stringify({
    type: 'notify',
    data: JSON.stringify({
      type: 'task_status',
      data: { status: 'COMPLETED' },
    }),
  })
);
assert.deepEqual(stringWrappedNotify, [{ type: 'task_status', data: { status: 'COMPLETED' } }]);

console.log('[tianxi-agentcore-protocol.test] ok');
