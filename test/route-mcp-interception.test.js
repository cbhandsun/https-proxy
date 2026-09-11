'use strict';

const assert = require('node:assert/strict');
const { createMcpInterception } = require('../lib/proxy/handlers/route-mcp-interception');

function createHarness(overrides = {}) {
  const state = { info: [], warn: [], ended: null, statusCode: null, requestEnd: null };
  const mcpHub = {
    extractToolCalls: () => [{ id: 'call-secret', name: 'lookup' }],
    interceptAndExecute: async () => [{ toolCallId: 'call-secret', output: 'ok' }],
    ...overrides.mcpHub,
  };
  const handle = createMcpInterception({
    mcpHub: overrides.mcpHub === null ? null : mcpHub,
    log: {
      info: (...args) => state.info.push(args.join(' ')),
      warn: (...args) => state.warn.push(args.join(' ')),
    },
    logRequestEnd: (...args) => {
      state.requestEnd = args;
    },
    parseJsonOrSseJson: overrides.parseJsonOrSseJson || JSON.parse,
  });
  const clientRes = {
    writeHead(statusCode) {
      state.statusCode = statusCode;
    },
    end(value) {
      state.ended = value;
    },
  };
  return { handle, clientRes, state };
}

async function run() {
  {
    const { handle, clientRes, state } = createHarness();
    const intercepted = await handle(
      '{"choices":[]}',
      'openai',
      clientRes,
      '/chat/completions',
      123,
      'POST'
    );
    assert.strictEqual(intercepted, true);
    assert.strictEqual(state.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(state.ended), {
      mcp_intercepted: true,
      results: [{ toolCallId: 'call-secret', output: 'ok' }],
    });
    assert.doesNotMatch(state.info.join(' '), /call-secret|output/i);
    assert.deepStrictEqual(state.requestEnd.slice(0, 4), ['POST', '/chat/completions', 123, 200]);
  }

  {
    const { handle, clientRes, state } = createHarness({ mcpHub: null });
    assert.strictEqual(await handle('{}', 'openai', clientRes, '/', 0, 'POST'), false);
    assert.strictEqual(state.statusCode, null);
  }

  {
    const { handle, clientRes, state } = createHarness({
      mcpHub: { extractToolCalls: () => [] },
    });
    assert.strictEqual(await handle('{}', 'openai', clientRes, '/', 0, 'POST'), false);
    assert.strictEqual(state.statusCode, null);
  }

  {
    const secret = 'user-content-must-not-be-logged';
    const { handle, clientRes, state } = createHarness({
      parseJsonOrSseJson: () => {
        throw new Error(secret);
      },
    });
    assert.strictEqual(await handle(secret, 'openai', clientRes, '/', 0, 'POST'), false);
    assert.strictEqual(state.warn.length, 1);
    assert.doesNotMatch(state.warn[0], new RegExp(secret));
    assert.strictEqual(state.statusCode, null);
  }

  console.log('[route-mcp-interception.test] ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
