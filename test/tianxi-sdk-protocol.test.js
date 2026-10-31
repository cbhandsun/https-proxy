'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseSdkInput, createSdkProtocol } = require('../lib/proxy/tianxi-sdk-protocol');
const {
  TIANXI_SDK_MODELS,
  tianxiSdkRoutes,
  sdkModel,
  supportsTianxiSdkClientTools,
} = require('../lib/proxy/tianxi-sdk-models');
const { mergeBuiltinModelRoutes } = require('../lib/proxy/builtin-model-routes');
const { buildLocalModelsResponse } = require('../lib/proxy/models');
const { endpointFromLog, prepareSdkWorkspace } = require('../lib/proxy/tianxi-sdk-workspace');
const token = 'sat-YQ.Yg.Yw';
function protocol(options = {}) {
  let id = 0;
  return createSdkProtocol({
    modelId: 'qfmodel',
    prompt: 'hello',
    instructions: 'brief',
    token,
    sameAccount: () => true,
    workerArgs: ['--tools', ''],
    cwd: 'owned',
    uuid: () => `id${++id}`,
    ...options,
  });
}
function ready(p) {
  assert.equal(p.start().request.type, 'daemon.initialize');
  assert.equal(
    p.accept({ type: 'control_response', response: { request_id: 'id1', subtype: 'success' } })
      .outbound[0].request.type,
    'daemon.open_session'
  );
  const init = p.accept({
    type: 'control_response',
    session_id: 'session',
    response: { request_id: 'id2', subtype: 'success' },
  }).outbound[0];
  assert.equal(init.request.appendSystemPrompt, 'brief');
  const query = p.accept({
    type: 'control_response',
    session_id: 'session',
    response: { request_id: 'id3', subtype: 'success' },
  }).outbound[0];
  assert.equal(query.message.content[0].text, 'hello');
}
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  modelUsage: { qfmodel: {} },
};
test('current Tianxi catalog maps uniquely, advertises tools and preserves configured routes', () => {
  assert.equal(TIANXI_SDK_MODELS.length, 12);
  assert.equal(new Set(TIANXI_SDK_MODELS.map((m) => m.modelId)).size, 12);
  assert.equal(new Set(TIANXI_SDK_MODELS.map((m) => m.alias)).size, 12);
  assert.deepEqual(
    TIANXI_SDK_MODELS.map((m) => m.modelId),
    [
      'auto',
      'fast',
      'qmodel_38max',
      'qfmodel',
      'qmodel',
      'dmodel',
      'dfmodel',
      'gmodel',
      'gfmodel',
      'kmodel_latest',
      'kmodel',
      'mmodel',
    ]
  );
  assert.equal(sdkModel('__proto__'), null);
  for (const route of tianxiSdkRoutes()) {
    assert.equal(route.to, route.tianxiSdkModel);
    assert.deepEqual(route.capabilities, ['function-call']);
    assert.deepEqual(route.inputModalities, ['text']);
  }
  assert.equal(mergeBuiltinModelRoutes({ profiles: [], modelRoutes: [] }).modelRoutes.length, 0);
  const override = { from: 'tianxi/auto', profileId: 'custom', to: 'custom' };
  const routes = mergeBuiltinModelRoutes({
    profiles: [{ id: 'tianxi-official' }],
    modelRoutes: [override],
  }).modelRoutes;
  assert.deepEqual(routes[0], override);
  assert.equal(routes.filter((r) => TIANXI_SDK_MODELS.some((m) => m.alias === r.from)).length, 12);
  const current = tianxiSdkRoutes();
  for (const alias of ['tianxi/kimi-k3', 'tianxi/minimax-m2.7']) {
    assert.equal(current.find((route) => route.from === alias).exposeInModels, false);
  }
  const publicModels = buildLocalModelsResponse(current, 'openai', 'openai-responses').data;
  assert.deepEqual(
    publicModels.map((model) => model.id).sort(),
    TIANXI_SDK_MODELS.map((model) => model.alias).sort()
  );
  assert.equal(
    current.find((route) => route.from === 'tianxi/kimi-k3.1-pro').tianxiSdkModel,
    'kmodel_latest'
  );
  assert.equal(
    current.find((route) => route.from === 'tianxi/minimax-m3.1-flash').tianxiSdkModel,
    'mmodel'
  );
  for (const id of [
    undefined,
    null,
    '',
    '__proto__',
    {},
    [],
    'dfmodel\n',
    'qmodel_latest',
    'q37fmodel',
    'gm51model',
  ]) {
    assert.equal(supportsTianxiSdkClientTools(id), false);
  }
});
test('SDK input validates text history, empty, illegal, extreme and media inputs', () => {
  const wrap = (input) => ({ input, metadata: { tianxi: { sdk_model: 'qfmodel' } } });
  assert.equal(parseSdkInput(wrap('hello')).prompt, 'hello');
  assert.equal(
    parseSdkInput(wrap([{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]))
      .prompt,
    '[user]\nhello'
  );
  for (const input of [
    null,
    {},
    [],
    '',
    ' ',
    '\0',
    'a'.repeat(128001),
    [{ role: 'user', content: [] }],
    [{ role: 'tool', content: 'x' }],
    [{ role: 'user', content: [null] }],
    [{ role: 'user', content: [{ type: 'input_image', image_url: 'x' }] }],
    Array(257).fill({ role: 'user', content: 'x' }),
  ])
    assert.throws(() => parseSdkInput(wrap(input)), /tianxi_sdk_input_invalid/);
  assert.throws(() => parseSdkInput(null), /model_invalid/);
  for (const instructions of [null, 1, '\0', 'a'.repeat(32769)])
    assert.throws(() => parseSdkInput({ ...wrap('x'), instructions }), /input_invalid/);
});
test('SDK handshake gates prompts and tokens, refuses callbacks and account drift', () => {
  const p = protocol();
  const auth = p.accept({
    type: 'control_request',
    request_id: 'auth',
    request: { type: 'daemon.auth.fetch_service_account_token' },
  });
  assert.equal(auth.outbound[0].response.response.token, token);
  assert.equal(
    p.accept({ type: 'control_request', request_id: 'deny', request: { type: 'can_use_tool' } })
      .outbound[0].response.error,
    'tianxi_sdk_callback_denied'
  );
  ready(p);
  assert.equal(p.accept(result).done, true);
  assert.equal(p.accept(result).frames.length, 0);
  assert.throws(() => protocol({ token: 'secret' }), /auth_invalid/);
  assert.throws(
    () =>
      protocol({ sameAccount: () => false }).accept({
        type: 'control_request',
        request_id: 'auth',
        request: { type: 'fetch_service_account_token' },
      }),
    /account_changed/
  );
  const flooded = protocol();
  for (let i = 0; i < 4; i++)
    flooded.accept({
      type: 'control_request',
      request_id: `a${i}`,
      request: { type: 'fetch_service_account_token' },
    });
  assert.throws(
    () =>
      flooded.accept({
        type: 'control_request',
        request_id: 'last',
        request: { type: 'fetch_service_account_token' },
      }),
    /account_changed/
  );
});
test('SDK streaming joins deltas and suppresses repeated assistant text', () => {
  const p = protocol();
  ready(p);
  let text = '';
  for (const value of ['MO', 'DEL_OK'])
    text += p.accept({
      type: 'stream_event',
      session_id: 'session',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: value } },
    }).frames[0].data.content;
  assert.equal(text, 'MODEL_OK');
  assert.equal(
    p.accept({
      type: 'assistant',
      message: { model: 'Qwen3.8-Flash', content: [{ type: 'text', text }] },
    }).frames.length,
    0
  );
  assert.equal(p.accept(result).frames[0].data.status, 'COMPLETED');
});
test('SDK fails closed for stage errors, malformed frames, failures, model drift and limits', () => {
  for (const frame of [
    null,
    [],
    {},
    { type: 'result', subtype: 'success' },
    { type: 'control_response', response: { request_id: 'id3', subtype: 'success' } },
    { type: 'control_request', request_id: 'bad\n', request: {} },
  ])
    assert.throws(() => protocol().accept(frame), /tianxi_sdk_/);
  for (const frame of [
    { ...result, is_error: true },
    { ...result, subtype: 'error' },
    { ...result, modelUsage: [] },
    { ...result, modelUsage: { dmodel: {} } },
    { type: 'assistant', message: { content: [null] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use' }] } },
    { type: 'assistant', error: 'secret' },
    { type: 'system', model: 'wrong' },
    { type: 'result', subtype: 'success', result: '' },
    { type: 'status_event', status: 'daemon.session_updated', data: { state: 'failed' } },
    { type: 'system', session_id: 'wrong' },
    { type: 'system', session_id: 12 },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(1048577) }] } },
  ]) {
    const p = protocol();
    ready(p);
    assert.throws(() => p.accept(frame), /tianxi_sdk_/);
  }
  const auto = protocol({ modelId: 'auto' });
  ready(auto);
  assert.equal(auto.accept({ ...result, modelUsage: { dmodel: {} } }).done, true);
});
test('SDK public endpoint selection and installed binary pin reject drift', () => {
  assert.equal(endpointFromLog('https://tenant-gateway.vpc.qoder.com.cn/v1'), 'tenant');
  for (const input of [
    '',
    null,
    'https://evil.test',
    'https://tenant-gateway.vpc.qoder.com.cn.evil.test',
    'https://a-gateway.vpc.qoder.com.cn https://b-gateway.vpc.qoder.com.cn',
    'x'.repeat(16 * 1024 * 1024 + 1),
  ])
    assert.throws(() => endpointFromLog(input), /endpoint_invalid/);
  assert.throws(
    () =>
      prepareSdkWorkspace('qfmodel', {
        endpoint: 'tenant',
        readFile: () => Buffer.from('changed'),
      }),
    /build_changed/
  );
  assert.throws(() => prepareSdkWorkspace('bad\n', { endpoint: 'tenant' }), /endpoint_invalid/);
});
