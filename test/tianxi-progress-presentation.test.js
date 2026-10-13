'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  formatTianxiNativeProgress,
  tianxiNativeToolOutcome,
  formatTianxiToolResult,
  TIANXI_RESULT_TOOLS,
  parseTianxiResultFormat,
  tianxiResultToolForFormat,
  tianxiProgressTarget,
  tianxiTaskProgressDetail,
  TIANXI_TASK_STARTED_TEXT,
} = require('../lib/proxy/tianxi-progress-presentation');

test('Native tool outcomes validate terminal states and retain unknown/running states', () => {
  for (const status of ['COMPLETED', 'complete', ' success ', 'SUCCEEDED', 'DONE'])
    assert.equal(tianxiNativeToolOutcome({ status }, {}), 'returned');
  for (const status of ['CANCELED', 'cancelled', 'ABORTED'])
    assert.equal(tianxiNativeToolOutcome({ status, success: false }, {}), 'canceled');
  for (const status of ['FAILED', 'ERROR'])
    assert.equal(tianxiNativeToolOutcome({}, { status }), 'failed');
  assert.equal(tianxiNativeToolOutcome({ success: false }, {}), 'failed');
  assert.equal(tianxiNativeToolOutcome({}, { success: false }), 'failed');
  for (const value of [undefined, null, [], 42, 'invalid'])
    assert.equal(tianxiNativeToolOutcome(value, value), 'returned');
  for (const status of [
    'RUNNING',
    'WORKING',
    'PENDING',
    'IN_PROGRESS',
    'UNKNOWN',
    '<script>secret</script>',
    'x'.repeat(10000),
    null,
    {},
    [],
    1,
  ])
    assert.equal(tianxiNativeToolOutcome({ status }, {}), null);
  assert.equal(tianxiNativeToolOutcome({ status: 'RUNNING' }, { status: 'COMPLETED' }), null);
});

test('Compact progress describes operations and reports failures without duplicate successes', () => {
  assert.equal(
    formatTianxiNativeProgress('Read', 2, 'started'),
    '\u8bfb\u53d6\u6587\u4ef6\uff08Read #2\uff09\n'
  );
  for (const name of [
    'Read',
    'Grep',
    'Glob',
    'LS',
    'Skill',
    'TodoWrite',
    'Bash',
    'Write',
    'Edit',
    'MultiEdit',
    'WebFetch',
    'WebSearch',
  ]) {
    assert.ok(formatTianxiNativeProgress(name, 1, 'started').includes(name + ' #1'));
    assert.ok(formatTianxiNativeProgress(name, 1, 'failed').includes('\u5931\u8d25'));
    assert.ok(formatTianxiNativeProgress(name, 1, 'canceled').includes('\u5df2\u53d6\u6d88'));
    assert.equal(formatTianxiNativeProgress(name, 1, 'returned'), '');
  }
  assert.match(formatTianxiNativeProgress('Read', 1, 'awaiting permission'), /\u6388\u6743/);
  assert.ok(formatTianxiNativeProgress('Read', 1, 'awaiting permission').includes('天禧应用'));
  assert.ok(TIANXI_TASK_STARTED_TEXT.endsWith('\n'));
});

test('task progress identifies real task subjects and requested status without claiming task completion', () => {
  const detail = tianxiTaskProgressDetail(
    'TaskCreate',
    JSON.stringify({ subject: 'Audit database schema', description: 'PRIVATE_DETAIL' })
  );
  assert.deepEqual(detail, { subject: 'Audit database schema', taskId: '', status: '' });
  const text = formatTianxiNativeProgress('TaskCreate', 1, 'started', { taskDetail: detail });
  assert.ok(text.includes('Audit database schema'));
  assert.equal(text.includes('PRIVATE_DETAIL'), false);
  assert.ok(text.includes('\u521b\u5efa\u4efb\u52a1'));
  const update = formatTianxiNativeProgress('TaskUpdate', 1, 'started', {
    taskDetail: { taskId: '2', status: 'completed' },
  });
  assert.ok(update.includes('\u8bf7\u6c42\u8bbe\u4e3a\u5df2\u5b8c\u6210'));
  assert.equal(update.includes('\u66f4\u65b0\u4efb\u52a1\u5df2\u5b8c\u6210'), false);
  for (const value of [
    null,
    [],
    {},
    'broken',
    { subject: '<script>' },
    { subject: 'sk_PRIVATE' },
    { subject: 'a'.repeat(161) },
    { subject: 'line\nline' },
    { taskId: 'PRIVATE_ID', status: 'PRIVATE_STATUS' },
  ]) {
    const result = tianxiTaskProgressDetail('TaskCreate', value);
    assert.equal(result?.subject || '', '');
    assert.equal(result?.taskId || '', '');
    assert.equal(result?.status || '', '');
  }
  assert.equal(tianxiTaskProgressDetail('Bash', { subject: 'Do not expose' }), null);
});

test('progress targets expose only safe relative file scopes and ignore query or command text', () => {
  assert.equal(
    tianxiProgressTarget('Read', { file_path: 'E:\\repo\\lib\\app.js' }, 'E:\\repo'),
    'lib/app.js'
  );
  assert.equal(
    tianxiProgressTarget('Glob', JSON.stringify({ pattern: 'test/**/*.js' })),
    'test/**/*.js'
  );
  assert.equal(tianxiProgressTarget('Grep', { path: 'lib', pattern: 'PRIVATE_QUERY' }), 'lib');
  for (const value of [
    null,
    [],
    {},
    'bad json',
    { path: '../outside' },
    { path: 'lib/../outside' },
    { path: '/etc/file' },
    { path: 'E:\\outside\\app.js' },
    { path: '.env' },
    { path: '.npmrc' },
    { path: 'auth.json' },
    { path: 'secret.txt' },
    { path: 'id_rsa' },
    { path: '<script>' },
    { path: 'a\n.js' },
    { path: 'a'.repeat(1025) },
  ]) {
    assert.equal(tianxiProgressTarget('Read', value, 'E:\\repo'), '');
  }
  assert.equal(tianxiProgressTarget('Bash', { path: 'app.js', command: 'PRIVATE_COMMAND' }), '');
  assert.equal(tianxiProgressTarget('Grep', { pattern: 'PRIVATE_QUERY' }), '');
  assert.equal(tianxiProgressTarget('Read', { path: 'E:\\repo\\app.js' }), '');
  assert.ok(
    formatTianxiNativeProgress('Read', 1, 'started', { target: 'lib/app.js' }).includes(
      '`lib/app.js`'
    )
  );
  assert.ok(
    formatTianxiNativeProgress('Read', 1, 'returned', {
      target: 'lib/app.js',
      showOutcome: true,
    }).includes('\u5df2\u5b8c\u6210')
  );
  assert.equal(formatTianxiNativeProgress('Read', 1, 'returned', { target: 'lib/app.js' }), '');
});

test('result display separates operation outcome from task status without raw metadata', () => {
  assert.equal(
    formatTianxiToolResult('Read', 1, 'completed', 'in_progress'),
    '\u8bfb\u53d6\u6587\u4ef6\uff08Read #1\uff09\uff1a\u5df2\u5b8c\u6210\u3002\n\u6574\u4f53\u4efb\u52a1\uff08\u8bfb\u53d6\u7ed3\u679c\u65f6\uff09\uff1a\u8fdb\u884c\u4e2d\u3002'
  );
  assert.equal(Object.isFrozen(TIANXI_RESULT_TOOLS), true);
  for (const tool of TIANXI_RESULT_TOOLS) {
    for (const status of ['in_progress', 'completed', 'failed', 'canceled', 'incomplete']) {
      const text = formatTianxiToolResult(tool, 512, status, status);
      assert.ok(text.includes(tool + ' #512'));
      assert.ok(text.length < 100);
    }
  }
});

test('result display rejects empty, malformed, extreme and unsafe values', () => {
  for (const tool of [null, undefined, {}, [], '', 'PRIVATE_PATH', 'constructor', 'toString'])
    assert.throws(() => formatTianxiToolResult(tool, 1, 'completed', 'completed'));
  for (const count of [null, '1', 0, -1, 1.5, 513, Infinity, NaN])
    assert.throws(() => formatTianxiToolResult('Read', count, 'completed', 'completed'));
  for (const status of [null, {}, [], '', 'PRIVATE_RESULT', 'constructor']) {
    assert.throws(() => formatTianxiToolResult('Read', 1, status, 'completed'));
    assert.throws(() => formatTianxiToolResult('Read', 1, 'completed', status));
  }
});

test('result format negotiation preserves full categories only for capable readers', () => {
  assert.equal(parseTianxiResultFormat(undefined), '1');
  for (const format of ['1', '2']) assert.equal(parseTianxiResultFormat(format), format);
  for (const value of [null, 1, 2, '', '3', '02', ' 2', [], {}, 'PRIVATE']) {
    assert.equal(parseTianxiResultFormat(value), null);
  }
  for (const tool of TIANXI_RESULT_TOOLS) {
    assert.equal(tianxiResultToolForFormat(tool, '2'), tool);
    assert.equal(
      tianxiResultToolForFormat(tool, '1'),
      tool.startsWith('Task') ? 'Operation' : tool
    );
  }
  for (const tool of [null, '', 'PRIVATE', 'constructor', {}]) {
    assert.throws(() => tianxiResultToolForFormat(tool, '2'));
  }
  assert.throws(() => tianxiResultToolForFormat('Read', 'PRIVATE'));
});

test('Unknown names, malformed counts and unsafe input have bounded non-sensitive fallbacks', () => {
  for (const name of [
    null,
    undefined,
    {},
    [],
    Symbol('secret'),
    '',
    '../SECRET',
    'sat_SECRET',
    'sk_SECRET',
    'Bearer_SECRET',
    'A'.repeat(65),
  ]) {
    const text = formatTianxiNativeProgress(name, 1, 'started');
    assert.ok(text.includes('tool #1'));
    assert.ok(!text.includes('SECRET'));
    assert.ok(text.length < 80);
  }
  for (const count of [
    undefined,
    null,
    '2',
    -1,
    0,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.ok(formatTianxiNativeProgress('Read', count, 'started').includes('Read #1'));
  }
  assert.ok(formatTianxiNativeProgress('Read', Number.MAX_SAFE_INTEGER, 'started').length < 80);
  for (const phase of [null, undefined, {}, [], 'SECRET'])
    assert.equal(formatTianxiNativeProgress('Read', 1, phase), '');
  for (const name of ['constructor', 'toString', 'Custom.Tool', 'a'.repeat(64)]) {
    assert.ok(formatTianxiNativeProgress(name, 1, 'started').includes(name));
  }
});
