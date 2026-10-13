'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  tianxiResultDetails,
  parseTianxiResultDetails,
  formatTianxiResultDetails,
} = require('../lib/proxy/tianxi-tool-result-details');
const { createTianxiToolResultCache } = require('../lib/proxy/tianxi-tool-result-cache');
const { createTianxiToolResultSession } = require('../lib/proxy/tianxi-tool-result-session');
const {
  createTianxiResultReader,
  createTianxiResultMcpServer,
} = require('../lib/proxy/tianxi-tool-result-mcp');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { Response } = globalThis;
const {
  createTianxiResultCall,
  isTianxiResultCall,
} = require('../lib/proxy/tianxi-tool-result-continuation');

test('safe file results extract envelope text and preserve literal JSON content', () => {
  for (const tool of ['Read', 'Grep', 'Glob', 'LS', 'List']) {
    const details = tianxiResultDetails(
      tool,
      'lib/file.js',
      JSON.stringify({ content: [{ type: 'text', text: 'line 1\nline 2' }], headers: 'INTERNAL' })
    );
    assert.deepEqual(details, {
      target: 'lib/file.js',
      preview: 'line 1\nline 2',
      truncated: false,
    });
    assert.match(
      formatTianxiResultDetails(tool, details),
      tool === 'Glob'
        ? /匹配模式：lib\/file.js\n结果预览：\nline 1/
        : /目标：lib\/file.js\n结果预览：\nline 1/
    );
  }
  assert.equal(
    tianxiResultDetails('Read', 'package.json', { content: '{"name":"example"}' }).preview,
    '{"name":"example"}'
  );
  for (const value of [null, '', {}, { headers: 'INTERNAL' }, '{broken', 'x'.repeat(32769)])
    assert.deepEqual(tianxiResultDetails('Read', 'a.js', value), { target: 'a.js' });
  assert.match(formatTianxiResultDetails('Read', { target: 'a.js' }), /未保留/);
});

test('native JSON-string file lists decode newlines and Windows separators without rewriting source escapes', () => {
  const list = '.next\\dev\\types\\package.json\npackage.json\nlib\\file.js';
  for (const tool of ['Glob', 'LS', 'List']) {
    for (const result of [
      JSON.stringify(list),
      { content: JSON.stringify(list) },
      JSON.stringify(JSON.stringify(list)),
    ]) {
      assert.equal(
        tianxiResultDetails(tool, 'package.json', result).preview,
        '.next/dev/types/package.json\npackage.json\nlib/file.js'
      );
    }
  }
  const source = 'const text = "a\\nb";\nconst path = "lib\\\\file.js";';
  assert.equal(tianxiResultDetails('Read', 'lib/file.js', JSON.stringify(source)).preview, source);
  assert.equal(
    tianxiResultDetails('Read', 'package.json', JSON.stringify('{"name":"example"}')).preview,
    '{"name":"example"}'
  );
  assert.equal(
    tianxiResultDetails('Glob', '*.json', { content: '"unfinished\\n' }).preview,
    '"unfinished\\n'
  );
});

test('decoded file lists still sanitize credentials and hide sensitive or external paths', () => {
  const list =
    'lib\\file.js\nC:\\outside\\file.js\n../outside.js\n.env\nauth.json\nOPENAI_API_KEY=hidden_value';
  const details = tianxiResultDetails('Glob', '*.json', JSON.stringify(list));
  assert.match(details.preview, /lib\/file.js/);
  assert.doesNotMatch(details.preview, /hidden_value|outside|\.env|auth\.json/);
  assert.equal((details.preview.match(/已隐藏/g) || []).length, 4);
  const huge = Array.from({ length: 100 }, (_, index) => `lib\\file${index}.js`).join('\n');
  const bounded = tianxiResultDetails('Glob', '*.js', JSON.stringify(huge));
  assert.equal(bounded.preview.split('\n').length, 8);
  assert.equal(bounded.truncated, true);
});

test('details reject unsafe targets, malformed metadata and accessors without coercion', () => {
  for (const target of [
    '../a',
    '/etc/passwd',
    'C:/outside/file.js',
    '.env',
    'auth.json',
    'secret.js',
    'a\n.js',
    '',
  ])
    assert.deepEqual(tianxiResultDetails('Read', target, 'CONTENT'), {});
  for (const value of [[], 'bad', 2])
    assert.throws(() => parseTianxiResultDetails('Read', value), TypeError);
  const value = {
    target: 'a.js',
    get preview() {
      throw new Error('accessor invoked');
    },
  };
  assert.deepEqual(parseTianxiResultDetails('Read', value), { target: 'a.js' });
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error('hostile');
      },
    }
  );
  assert.deepEqual(parseTianxiResultDetails('Read', hostile), {});
  assert.deepEqual(tianxiResultDetails('Read', 'a.js', hostile), { target: 'a.js' });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.deepEqual(tianxiResultDetails('Read', 'a.js', revoked.proxy), { target: 'a.js' });
});

test('previews bound lines and Unicode and redact credentials before display', () => {
  const raw =
    'OPENAI_API_KEY=hidden_value\nSERVICE_ACCESS_TOKEN="hidden_token"\nAuthorization: Bearer hidden_auth\nCookie: hidden_cookie\nsk-test-hidden\neyJabc.abc.def\n-----BEGIN PRIVATE KEY-----\nhidden_pem\n-----END PRIVATE KEY-----';
  const details = tianxiResultDetails('Read', 'a.js', { content: raw });
  assert.doesNotMatch(details.preview, /hidden/);
  assert.equal(details.preview.split('\n').length <= 8, true);
  const unicode = parseTianxiResultDetails('Read', { target: 'a.js', preview: '😀'.repeat(600) });
  assert.equal(Array.from(unicode.preview).length, 512);
  assert.equal(unicode.truncated, true);
  const lines = parseTianxiResultDetails('Read', {
    target: 'a.js',
    preview: Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n'),
  });
  assert.equal(lines.preview.split('\n').length, 8);
  assert.equal(lines.truncated, true);
  assert.equal(
    parseTianxiResultDetails('Read', { target: 'a.js', preview: 'a\u0000\u202eb' }).preview,
    'ab'
  );
});

test('detail bytes share cache capacity and release after discard and expiry', () => {
  let now = 0;
  const cache = createTianxiToolResultCache({ maxBytes: 90, ttlMs: 10, now: () => now });
  const one = cache.begin('owner');
  const op = cache.start('owner', one, 'one', 'Read', { target: 'a.js' });
  assert.equal(
    cache.finish('owner', one, 'one', 'completed', { target: 'a.js', preview: 'x'.repeat(100) }),
    true
  );
  assert.deepEqual(cache.lookup('owner', op.reference).details, { target: 'a.js' });
  assert.equal(
    cache.finish('owner', one, 'one', 'completed', { target: 'b.js', preview: 'changed' }),
    true
  );
  assert.deepEqual(cache.lookup('owner', op.reference).details, { target: 'a.js' });
  cache.discard('owner', one);
  const two = cache.begin('owner');
  const op2 = cache.start('owner', two, 'two', 'Read', { target: 'b.js', preview: 'small' });
  assert.equal(op2.details.preview, 'small');
  op2.details.preview = 'mutated';
  assert.equal(cache.lookup('owner', op2.reference).details.preview, 'small');
  now = 10;
  const three = cache.begin('owner');
  assert.equal(
    cache.start('owner', three, 'three', 'Read', { target: 'c.js', preview: 'small' }).details
      .preview,
    'small'
  );
});

test('native session, bounded HTTP reader and MCP SDK retain meaningful text-only cards', async () => {
  const cache = createTianxiToolResultCache();
  const session = createTianxiToolResultSession(cache, 'owner');
  const call = session.start('read', 'Read', 'lib/file.js');
  const reference = call.call_id.replace('call_tianxi_result_', '');
  session.finish('read', 'returned', JSON.stringify({ content: 'actual file line' }));
  const reader = createTianxiResultReader({
    credential: () => '',
    fetch: async () =>
      Response.json({
        object: 'tianxi.tool_result',
        ...cache.lookup('owner', reference),
        headers: 'INTERNAL',
      }),
  });
  const server = createTianxiResultMcpServer(reader);
  const client = new Client({ name: 'detail-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    const result = await client.callTool({ name: 'read_result', arguments: { reference } });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent, undefined);
    assert.match(result.content[0].text, /目标：lib\/file.js/);
    assert.match(result.content[0].text, /actual file line/);
    assert.doesNotMatch(result.content[0].text, /INTERNAL|txr_/);
    assert.equal(cache.lookup('other', reference), null);
  } finally {
    await client.close();
    await server.close();
  }
});

test('settled-task eviction releases both preview and final-response bytes', () => {
  const details = { target: 'a.js', preview: 'line', truncated: false };
  const response = { status: 'completed', output: [] };
  const maxBytes =
    Buffer.byteLength(JSON.stringify(details)) + Buffer.byteLength(JSON.stringify(response));
  const cache = createTianxiToolResultCache({ maxTasks: 1, maxBytes });
  for (let index = 0; index < 4; index++) {
    const task = cache.begin('owner');
    const op = cache.start('owner', task, 'read', 'Read', details);
    assert.equal(op.details.preview, 'line');
    assert.equal(cache.settle('owner', task, 'completed', response), true);
  }
});

test('invalid optional result details fail the reader instead of exposing native metadata', async () => {
  const reference = 'txr_' + '1'.repeat(32);
  const reader = createTianxiResultReader({
    credential: () => '',
    fetch: async () =>
      Response.json({
        object: 'tianxi.tool_result',
        reference,
        tool: 'Read',
        ordinal: 1,
        status: 'completed',
        taskStatus: 'completed',
        details: 'RAW_INTERNAL',
      }),
  });
  await assert.rejects(reader(reference), /Invalid result details/);
});

test('native preview retention cannot renew the abandoned-consumer lease', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cache = createTianxiToolResultCache();
  const session = createTianxiToolResultSession(cache, 'owner', {
    parallelToolCalls: false,
    live: true,
  });
  let canceled = 0;
  session.enableLive('tianxi/super', () => canceled++);
  session.start('one', 'Read', 'a.js');
  t.mock.timers.tick(59000);
  session.finish('one', 'returned', 'actual line');
  t.mock.timers.tick(1000);
  assert.equal(canceled, 1);
});

test('code-mode selects category readers and falls back to the existing read-only receipt', async () => {
  const reference = 'txr_' + '2'.repeat(32);
  const categories = {
    Read: 'read_result',
    Glob: 'glob_result',
    Grep: 'search_result',
    LS: 'list_result',
    TaskList: 'task_result',
    Operation: 'operation_result',
  };
  const binding = { kind: 'code_mode', namespace: 'functions', name: 'exec' };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const [tool, category] of Object.entries(categories)) {
    const call = createTianxiResultCall(reference, binding, tool);
    assert.equal(isTianxiResultCall(call), true);
    assert.equal(
      isTianxiResultCall({ ...call, input: call.input + '\nthrow new Error("injected")' }),
      false
    );
    for (const legacy of [false, true]) {
      const names = legacy ? ['read_result'] : Object.values(categories);
      let selected;
      const tools = Object.fromEntries(
        names.map((name) => [
          'mcp__tianxi_progress__' + name,
          async (args) => {
            assert.deepEqual(args, { reference });
            selected = name;
            return { content: [{ type: 'text', text: 'receipt' }] };
          },
        ])
      );
      const output = [];
      await new AsyncFunction('ALL_TOOLS', 'tools', 'text', call.input)(
        Object.keys(tools).map((name) => ({ name })),
        tools,
        (text) => output.push(text)
      );
      assert.equal(selected, legacy ? 'read_result' : category);
      assert.deepEqual(output, ['receipt']);
    }
  }
});

test('category MCP readers reject cross-category references and expose only text results', async () => {
  const reference = 'txr_' + '3'.repeat(32);
  let tool = 'Glob';
  const server = createTianxiResultMcpServer(async () => ({
    reference,
    tool,
    ordinal: 1,
    status: 'completed',
    taskStatus: 'in_progress',
    details: { target: 'package.json', preview: 'package.json' },
  }));
  const client = new Client({ name: 'category-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    for (const [native, name] of Object.entries({
      Glob: 'glob_result',
      Grep: 'search_result',
      LS: 'list_result',
      TaskList: 'task_result',
      Operation: 'operation_result',
    })) {
      tool = native;
      const result = await client.callTool({ name, arguments: { reference } });
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent, undefined);
      const mismatch = await client.callTool({
        name: name === 'glob_result' ? 'search_result' : 'glob_result',
        arguments: { reference },
      });
      assert.equal(mismatch.isError, true);
      assert.equal(
        (await client.callTool({ name: 'read_result', arguments: { reference } })).isError,
        false
      );
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('native category receipts are immutable and retain their category on continuation', () => {
  const cache = createTianxiToolResultCache();
  const session = createTianxiToolResultSession(cache, 'owner', {
    parallelToolCalls: false,
    resultTool: { kind: 'code_mode', namespace: 'functions', name: 'exec' },
  });
  const first = session.start('one', 'Glob', '*.json');
  assert.match(first.input, /__glob_result/);
  assert.equal(session.start('one', 'Glob', '*.json'), first);
  const second = session.start('two', 'Glob', '*.js');
  assert.match(second.input, /__glob_result/);
  session.finish('one', 'returned', JSON.stringify('package.json'));
  session.finish('two', 'returned', JSON.stringify('lib/file.js'));
  session.settle({ status: 'completed', output: [] });
  const ref = first.call_id.replace('call_tianxi_result_', '');
  assert.match(cache.continuation('owner', [ref]).nextCall.input, /__glob_result/);
});
