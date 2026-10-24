'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { claudeStreamToolDeclarations } = require('../lib/proxy/claude-stream-tool-context');
const tool = {
  name: 'mcp__fixture__original',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};
const wire = (tools) =>
  Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'not retained' }], tools }));

test('Claude stream context retains only fresh function names and schemas from this bounded request', () => {
  const bytes = wire([tool, { type: 'web_search_20250305', name: 'web_search' }]);
  const result = claudeStreamToolDeclarations(bytes, bytes.length);
  assert.deepEqual(result, [tool]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0]), true);
  bytes.fill(0);
  assert.deepEqual(result, [tool]);
  assert.deepEqual(claudeStreamToolDeclarations(wire([{ name: 'other' }]), 4096), [
    { name: 'other', input_schema: { type: 'object', properties: {} } },
  ]);
  assert.deepEqual(claudeStreamToolDeclarations(wire([]), 4096), []);
});

test('invalid, duplicate, oversized or undecodable declaration contexts grant no empty-argument authority', () => {
  for (const buffer of [
    undefined,
    null,
    [],
    {},
    Buffer.alloc(0),
    Buffer.from('null'),
    Buffer.from('[]'),
    Buffer.from('{'),
    Buffer.from([255]),
    wire({}),
    wire([null]),
    wire([{}]),
    wire([{ name: '' }]),
    wire([{ name: 'x', input_schema: [] }]),
    wire([tool, tool]),
    wire([{ ...tool, strict: 'true' }]),
  ]) {
    assert.deepEqual(claudeStreamToolDeclarations(buffer, 4096), []);
  }
  const bytes = wire([tool]);
  assert.deepEqual(claudeStreamToolDeclarations(bytes, bytes.length - 1), []);
  for (const maximum of [0, -1, 1.5, Infinity, NaN, '4096', Number.MAX_SAFE_INTEGER + 1])
    assert.deepEqual(claudeStreamToolDeclarations(bytes, maximum), []);
});

test('declaration admission never invokes caller hooks and does not promote prototype metadata', () => {
  let hooks = 0;
  const proxy = new Proxy(Buffer.from('{}'), {
    get() {
      hooks++;
      return 1;
    },
  });
  const accessor = {
    get length() {
      hooks++;
      return 100;
    },
  };
  for (const value of [
    proxy,
    accessor,
    {
      toString() {
        hooks++;
        return '{}';
      },
    },
  ])
    assert.deepEqual(claudeStreamToolDeclarations(value, 4096), []);
  assert.equal(hooks, 0);
  const result = claudeStreamToolDeclarations(
    Buffer.from(
      '{"tools":[{"name":"mcp__fixture__original","input_schema":{"type":"object"},"__proto__":{"polluted":true}}]}'
    ),
    4096
  );
  assert.deepEqual(Object.keys(result[0]).sort(), ['input_schema', 'name']);
  assert.equal(Object.prototype.polluted, undefined);
});

test('unexpected decoder failures are not swallowed as absent declarations', () => {
  const original = globalThis.TextDecoder;
  const cause = new Error('unexpected_codec_failure');
  try {
    globalThis.TextDecoder = class {
      decode() {
        throw cause;
      }
    };
    assert.throws(
      () => claudeStreamToolDeclarations(wire([tool]), 4096),
      (error) => error === cause
    );
  } finally {
    globalThis.TextDecoder = original;
  }
});
