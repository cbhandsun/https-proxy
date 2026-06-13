const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createDiagnostics } = require('../lib/proxy/diagnostics');

function safeUnlink(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {}
}

const diagnostics = createDiagnostics({
  config: { diagnostics: { enabled: true } },
  normalizeClaudeContent(content) {
    return Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }];
  },
  sanitizeGeminiToolCall() {
    return {};
  },
});

const redacted = diagnostics.redactDiagnosticsValue({
  apiKey: 'secret',
  headers: { authorization: 'Bearer abc', ok: 'yes' },
  nested: [{ 'x-goog-api-key': 'gemini' }],
});
assert.strictEqual(redacted.apiKey, '[redacted]');
assert.strictEqual(redacted.headers.authorization, '[redacted]');
assert.strictEqual(redacted.headers.ok, 'yes');
assert.strictEqual(redacted.nested[0]['x-goog-api-key'], '[redacted]');

const summary = diagnostics.summarizeClaudeToolHistory({
  messages: [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a' } }],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'abc' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'x', is_error: true }],
    },
  ],
  tools: [{ name: 'Read' }],
});
assert.strictEqual(summary.messageCount, 4);
assert.deepStrictEqual(summary.declaredTools, ['Read']);
assert.deepStrictEqual(
  summary.toolUses.map((item) => item.id),
  ['toolu_1', 'toolu_1']
);
assert.deepStrictEqual(summary.duplicateToolUseIds, ['toolu_1']);
assert.strictEqual(summary.toolResults[0].hasMatchingToolUse, true);
assert.strictEqual(summary.toolResults[1].hasMatchingToolUse, false);

assert.strictEqual(
  diagnostics.extractDiagnosticsSsePayload('content_block_delta', {
    index: 0,
    delta: { type: 'text_delta', text: 'hello' },
  }),
  null
);
const deltaPayload = diagnostics.extractDiagnosticsSsePayload('content_block_delta', {
  index: 1,
  delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
});
assert.strictEqual(deltaPayload.event, 'content_block_delta');
assert.strictEqual(deltaPayload.partial_json, '{"command":"ls"}');
const startPayload = diagnostics.extractDiagnosticsSsePayload('content_block_start', {
  index: 2,
  content_block: { type: 'tool_use', id: 'toolu', name: 'Bash', input: {} },
});
assert.strictEqual(startPayload.toolUseId, 'toolu');
assert.strictEqual(startPayload.toolName, 'Bash');

(async () => {
  const filePath = path.join(
    os.tmpdir(),
    'https-proxy-diagnostics-test-' + process.pid + '-' + Date.now() + '.jsonl'
  );
  const rotated = filePath + '.1';
  try {
    fs.writeFileSync(filePath, 'x'.repeat(2048));
    safeUnlink(rotated);
    assert.strictEqual(diagnostics.writeJsonlBounded(filePath, { ok: true }, 1024), true);
    await diagnostics.flushJsonlWrites();
    assert.ok(fs.existsSync(rotated));
    const text = fs.readFileSync(filePath, 'utf8');
    assert.ok(text.includes('"ok":true'));
  } finally {
    safeUnlink(filePath);
    safeUnlink(rotated);
  }

  console.log('[diagnostics.test] ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
