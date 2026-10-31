'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createNativeToolDocs } = require('../scripts/lib/tianxi-native-tool-docs');
const { createTianxiNativeCatalog } = require('../scripts/lib/tianxi-native-responses-catalog');
const { createTianxiNativeSession } = require('../scripts/lib/tianxi-native-responses-session');
const initial = fs.readFileSync(
  path.join(__dirname, 'fixtures/tianxi-codex-exec-initial.txt'),
  'utf8'
);
const description =
  initial +
  '\n## additional_namespace\n\n### `external_tool`\n' +
  'original app tool documentation. '.repeat(24000);
const body = {
  model: 'tianxi/qwen3.8-flash',
  tools: [
    { name: 'exec', namespace: 'functions', type: 'custom', description, format: { type: 'text' } },
  ],
  input: [{ role: 'user', content: 'native task' }],
};

test('large native documentation is paged byte-for-byte within the unchanged SDK description/result budgets', () => {
  const docs = createNativeToolDocs(description);
  assert.ok(docs.compact.length < 30000);
  assert.ok(!docs.compact.includes('original app tool documentation'));
  let offset = 0,
    reconstructed = '';
  do {
    const result = docs.call(docs.definition.name, { offset });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 65536);
    const page = JSON.parse(result.content[0].text);
    reconstructed += page.text;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(reconstructed, description);
  const match = JSON.parse(
    docs.call(docs.definition.name, { query: 'external_tool' }).content[0].text
  );
  assert.ok(match.found);
  assert.ok(match.text.startsWith('external_tool'));
  assert.equal(
    JSON.parse(docs.call(docs.definition.name, { query: 'not present' }).content[0].text).found,
    false
  );
  assert.equal(docs.call('unregistered', {}), undefined);
  assert.throws(() => createTianxiNativeCatalog(body), /catalog_invalid/);
  const catalog = createTianxiNativeCatalog(body, { allowPagedDocs: true });
  assert.equal(catalog.definitions.length, 2);
  assert.ok(catalog.definitions.every((tool) => tool.description.length < 32768));
});

test('documentation boundary rejects malformed, excessive and modified core contracts and unsafe page inputs', () => {
  for (const invalid of [
    null,
    '',
    'x' + initial,
    initial.replace('Runs a command', 'Changed authority'),
    initial + initial.slice(initial.indexOf('### `apply_patch`')),
    initial + '\0',
    initial + 'x'.repeat(1048576),
  ]) {
    assert.throws(() => createNativeToolDocs(invalid));
  }
  const docs = createNativeToolDocs(description);
  for (const args of [
    null,
    { offset: -1 },
    { offset: 1.1 },
    { offset: description.length + 1 },
    { query: 1 },
    { query: 'x'.repeat(129) },
    { query: '\0' },
    { unexpected: true },
  ])
    assert.throws(() => docs.call(docs.definition.name, args));
  for (const tool of [
    { ...body.tools[0], name: 'other' },
    { ...body.tools[0], type: 'function' },
  ])
    assert.throws(() =>
      createTianxiNativeCatalog({ ...body, tools: [tool] }, { allowPagedDocs: true })
    );
});

test('SDK-local documentation reads do not become Codex execution calls and raw source remains unchanged', async () => {
  let dispatched = 0;
  const task = createTianxiNativeSession({
    body,
    owner: 'owner',
    allowHistory: true,
    onCall() {
      dispatched++;
    },
    run: async (options) => {
      const docs = options.tools.find((tool) => tool.name === 'codex_native_documentation');
      const page = await options.onCall(
        docs.name,
        { query: 'external_tool' },
        { signal: options.signal }
      );
      assert.match(page.content[0].text, /original app tool documentation/);
      const result = await options.onCall(
        options.tools[0].name,
        { input: 'text(await tools.exec_command({cmd:"native"}));' },
        { signal: options.signal }
      );
      return { finalText: result.content[0].text };
    },
  });
  const call = (await task.next()).output[0];
  assert.equal(dispatched, 1);
  assert.equal(call.input, 'text(await tools.exec_command({cmd:"native"}));');
  assert.equal(
    (
      await task.resume(
        [{ type: 'custom_tool_call_output', call_id: call.call_id, output: 'done' }],
        'owner',
        body.model
      )
    ).output_text,
    'done'
  );
  await task.done;
});
