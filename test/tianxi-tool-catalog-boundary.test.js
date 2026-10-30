'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { unsupportedTianxiResponsesFeature } = require('../lib/proxy/tianxi-request-contract');
const { createTianxiOfficialHandlers } = require('../lib/proxy/tianxi-official-handlers');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');

const catalog = (type, tools) => ({
  type,
  role: 'developer',
  status: 'completed',
  execution: 'client',
  tools,
});
const declared = [{ type: 'function', name: 'read_file' }];

test('embedded catalogs require a tool-capable route and validate their boundaries', () => {
  for (const type of ['additional_tools', 'tool_search_output']) {
    for (const wrap of [(item) => [item], (item) => [{ role: 'developer', content: [item] }]]) {
      const body = { input: wrap(catalog(type, declared)) };
      assert.equal(unsupportedTianxiResponsesFeature(body), 'tools');
      assert.equal(unsupportedTianxiResponsesFeature(body, { nativeReadTools: true }), null);
    }
    for (const tools of [undefined, null, 'PRIVATE', {}, [null], [[]], [1], Array(1025).fill({})]) {
      assert.equal(
        unsupportedTianxiResponsesFeature(
          { input: [catalog(type, tools)] },
          { nativeReadTools: true }
        ),
        'tools'
      );
    }
    assert.equal(unsupportedTianxiResponsesFeature({ input: [catalog(type, [])] }), null);
    assert.equal(
      unsupportedTianxiResponsesFeature(
        { input: [catalog(type, Array(1024).fill({ type: 'function', name: 'read' }))] },
        { nativeReadTools: true }
      ),
      null
    );
  }
  for (const input of [
    undefined,
    null,
    '',
    [],
    'additional_tools',
    [{ role: 'user', content: 'hello' }],
  ])
    assert.equal(unsupportedTianxiResponsesFeature({ input }), null);
});

test('chat rejects advertised tools before stripping or upstream execution in both response modes', async () => {
  for (const type of ['additional_tools', 'tool_search_output']) {
    for (const stream of [false, true]) {
      let calls = 0;
      const logs = [];
      const handlers = createTianxiOfficialHandlers({
        sendJsonError(res, status, value) {
          res.status = status;
          res.value = value;
        },
        logRequestEnd(...args) {
          logs.push(args);
        },
        openAIResponsesToChat() {
          throw new Error('must reject before conversion');
        },
        callTianxiOfficialBridge() {
          calls++;
          throw new Error('must not call upstream');
        },
      });
      const res = {};
      await handlers.handleTianxiOfficialResponses(
        { headers: {}, method: 'POST' },
        res,
        Buffer.from(
          JSON.stringify({
            model: 'tianxi/chat',
            stream,
            tools: [],
            input: [catalog(type, declared), { role: 'user', content: 'PRIVATE_USER_CONTENT' }],
          })
        ),
        { rewriteTo: 'chat', profile: { id: 'tianxi-official' }, route: { to: 'chat' } },
        Date.now(),
        '/v1/responses'
      );
      assert.equal(res.status, 422);
      assert.equal(res.value.error.code, 'tianxi_tool_bridge_unsupported');
      assert.equal(res.value.error.param, 'tools');
      assert.match(res.value.error.message, /tianxi\/super/);
      assert.equal(calls, 0);
      assert.ok(!JSON.stringify([res, logs]).includes('PRIVATE_USER_CONTENT'));
    }
  }
});

test('catalog regression runs through the unified unit test discovery', () => {
  assert.ok(
    selectUnitTestFiles(discoverTestFiles(require('node:path').resolve(__dirname, '..'))).includes(
      'test/tianxi-tool-catalog-boundary.test.js'
    )
  );
});
