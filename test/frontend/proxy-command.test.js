'use strict';

const assert = require('node:assert/strict');

(async () => {
  const { executeHealthCommand, formatHealthCommandResult, formatProxyCommandError } =
    await import('../../tauri-ui/src/app/models/proxy-command.js');

  const healthy = formatHealthCommandResult({ ok: true, status: '<script>unsafe</script>' });
  assert.equal(healthy.code, 0);
  assert.equal(healthy.ok, true);
  assert.equal(healthy.running, true);
  assert.match(healthy.output, /状态: 正常/);
  assert.doesNotMatch(healthy.output, /script|unsafe/);

  for (const value of [undefined, null, [], '', { ok: false }, { ok: 'true' }]) {
    const result = formatHealthCommandResult(value);
    assert.equal(result.code, -1);
    assert.equal(result.ok, false);
    assert.equal(result.running, false);
  }

  let calls = 0;
  const executed = await executeHealthCommand(async () => {
    calls += 1;
    return { ok: true };
  });
  assert.equal(calls, 1);
  assert.equal(executed.code, 0);

  const failed = await executeHealthCommand(async () => {
    throw new Error('token=must-not-be-reflected');
  });
  assert.equal(failed.code, -1);
  assert.doesNotMatch(failed.output, /token|must-not-be-reflected/);
  await assert.rejects(executeHealthCommand(null), /fetchHealth must be a function/);

  for (const error of ['proxy_stop_drain_unconfirmed', new Error('proxy_stop_drain_unconfirmed')]) {
    const result = formatProxyCommandError(error);
    assert.equal(result.code, -1);
    assert.match(result.output, /4 秒.*未确认完成/);
    assert.doesNotMatch(result.output, /proxy_stop_/);
  }
  assert.match(formatProxyCommandError('proxy_stop_drain_failed').output, /资源清理/);
  const hostile = Object.defineProperty({}, 'message', {
    get() {
      throw new Error('PRIVATE');
    },
  });
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error('PRIVATE');
      },
    }
  );
  for (const error of [
    undefined,
    null,
    '',
    [],
    {},
    hostile,
    proxy,
    123,
    'token=PRIVATE',
    'x'.repeat(100000),
  ]) {
    const result = formatProxyCommandError(error);
    assert.equal(result.code, -1);
    assert.doesNotMatch(result.output, /PRIVATE|token|undefined/);
    assert.ok(result.output.length < 100);
  }

  console.log('[proxy-command.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
