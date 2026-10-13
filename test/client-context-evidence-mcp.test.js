'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createContextEvidenceMcpServer } = require('../lib/client/context-evidence-mcp');

test('MCP advertises only read-only tools and separates trusted host capture from readers', async (t) => {
  const runtime = createContextEvidenceMcpServer();
  const client = new Client({ name: 'synthetic-evidence-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await runtime.server.close();
  });
  await runtime.server.connect(serverTransport);
  await client.connect(clientTransport);
  const advertised = await client.listTools();
  assert.equal(advertised.tools.length, 2);
  assert.equal(
    advertised.tools.some((tool) => /capture/.test(tool.name)),
    false
  );
  assert.equal(
    advertised.tools.every(
      (tool) => tool.annotations.readOnlyHint && !tool.annotations.openWorldHint
    ),
    true
  );
  const call = (name, args, thread = 'thread-test') =>
    client.callTool({ name, arguments: args, _meta: { threadId: thread } });
  const capture = await call('hpm_capture_completed_hook', {
    hook_event_name: 'PostToolUse',
    session_id: 'thread-test',
    tool_use_id: 'call-1',
    tool_name: 'synthetic_tool',
    tool_input: {},
    tool_response: '',
  });
  assert.deepEqual(capture.content, [{ type: 'text', text: '{}' }]);
  const index = JSON.parse((await call('hpm_list_retained_evidence', {})).content[0].text);
  const source = index.sources[0];
  assert.equal(
    JSON.parse(
      (
        await call('hpm_read_retained_evidence', {
          sourceId: source.sourceId,
          digest: source.digest,
        })
      ).content[0].text
    ).page.text,
    ''
  );
  const badArgs = await call('hpm_list_retained_evidence', { limit: 'secret' });
  assert.equal(badArgs.isError, true);
  assert.equal(badArgs.content[0].text.includes('secret'), false);
  assert.equal((await call('hpm_list_retained_evidence', {}, 'foreign')).isError, true);
  assert.equal((await call('unknown', {})).isError, true);
  await assert.rejects(
    call('hpm_capture_completed_hook', { secret: 'never-log' }),
    (problem) =>
      problem.message.includes('invalid_hook_event') && !problem.message.includes('never-log')
  );
  // Missing arguments default to an empty reader request, never session selection.
  assert.equal(
    (
      await client.callTool({
        name: 'hpm_list_retained_evidence',
        _meta: { threadId: 'thread-test' },
      })
    ).isError,
    false
  );
  await client.close();
  assert.equal(runtime.session.inspect().closed, true);
});
