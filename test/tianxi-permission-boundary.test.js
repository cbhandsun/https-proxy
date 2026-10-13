'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  assertTianxiPermissionSupported,
  tianxiReadOnlyInstructions,
  TIANXI_PERMISSION_MESSAGE,
} = require('../lib/proxy/tianxi-permission-boundary');

test('Tianxi permission boundary rejects unsupported approval without exposing native content', () => {
  for (const data of [
    undefined,
    {},
    { tool: 'Bash', token: 'secret-unit', text: 'private-unit' },
  ]) {
    assert.throws(
      () => assertTianxiPermissionSupported({ type: 'risk_exec', data }),
      (error) => {
        assert.equal(error.code, 'tianxi_native_permission_required');
        assert.equal(error.statusCode, 403);
        assert.equal(error.message, TIANXI_PERMISSION_MESSAGE);
        assert.ok(!JSON.stringify(error).includes('secret-unit'));
        assert.ok(!error.message.includes('private-unit'));
        return true;
      }
    );
  }
});

test('Tianxi permission boundary preserves empty, malformed and ordinary frames', () => {
  for (const frame of [
    null,
    undefined,
    '',
    0,
    [],
    {},
    { type: 'act_exec' },
    { type: 'task_status' },
  ]) {
    assert.doesNotThrow(() => assertTianxiPermissionSupported(frame));
  }
});

test('Tianxi readonly instructions preserve user instructions and explicitly describe limits', () => {
  for (const instructions of [undefined, null, '', {}, [], 'Inspect files']) {
    assert.equal(tianxiReadOnlyInstructions(instructions, false), instructions);
    const result = tianxiReadOnlyInstructions(instructions, true);
    assert.equal(typeof result, 'string');
    assert.ok(result.includes('only Read, Glob and Grep'));
    assert.ok(result.includes('unverified'));
    if (typeof instructions === 'string' && instructions.trim())
      assert.ok(result.includes(instructions));
  }
  const extreme = 'x'.repeat(128000);
  assert.ok(tianxiReadOnlyInstructions(extreme, true).includes(extreme));
});
