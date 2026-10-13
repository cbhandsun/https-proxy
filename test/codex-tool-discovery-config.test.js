'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  configureCodexToolDiscovery,
  readCodexToolDiscoveryStatus,
  validateCodexToolDiscoveryOption,
  validateCodexToolDiscoveryOptions,
} = require('../lib/proxy/codex-tool-discovery-config');
const {
  TOOL_DISCOVERY_HEADER,
  TOOL_DISCOVERY_CAPABILITY,
} = require('../lib/proxy/context-tool-catalog');
const header = `"${TOOL_DISCOVERY_HEADER}" = "${TOOL_DISCOVERY_CAPABILITY}"`;
const table = '[model_providers.custom.http_headers]';
const initial = 'model = "unchanged"\n[model_providers.custom]\nname = "HTTPS Proxy"\n';

test('discovery is opt-in, persisted on reapply, idempotent and explicitly reversible', () => {
  assert.deepEqual(readCodexToolDiscoveryStatus(''), { enabled: false, editable: true });
  assert.equal(configureCodexToolDiscovery(initial).content, initial);
  assert.equal(configureCodexToolDiscovery(initial, false).content, initial);
  const enabled = configureCodexToolDiscovery(initial, true);
  assert.equal(enabled.enabled, true);
  assert.ok(enabled.content.includes(table + '\n' + header));
  assert.equal(configureCodexToolDiscovery(enabled.content).content, enabled.content);
  assert.equal(configureCodexToolDiscovery(enabled.content, true).content, enabled.content);
  const disabled = configureCodexToolDiscovery(enabled.content, false);
  assert.equal(disabled.enabled, false);
  assert.ok(!disabled.content.includes(header));
  assert.deepEqual(readCodexToolDiscoveryStatus(disabled.content), {
    enabled: false,
    editable: true,
  });
});
test('nested header editing preserves unrelated headers, policies, providers and comments', () => {
  const suffix = '\n[projects."E:/安全🙂"]\ntrust_level = "trusted"\n';
  const original = initial + table + '\n# user-owned header\n"X-Custom" = "fixture"\n' + suffix;
  const result = configureCodexToolDiscovery(original, true);
  assert.ok(result.content.endsWith(suffix));
  assert.ok(result.content.includes('# user-owned header\n"X-Custom" = "fixture"\n'));
  assert.equal(configureCodexToolDiscovery(result.content, false).content, original);
  for (const entry of [
    header,
    "'x-hpm-tool-discovery' = 'hpm-function-discovery-v1' # comment",
    'x-hpm-tool-discovery = "hpm-function-discovery-v1"',
  ]) {
    const content = initial + table + '\n' + entry + '\n';
    assert.equal(readCodexToolDiscoveryStatus(content).enabled, true);
    assert.equal(configureCodexToolDiscovery(content, false).enabled, false);
  }
});
test('ordinary reapply preserves user inline maps, while toggles reject them without guessing', () => {
  const content = initial + 'http_headers = { "X-Custom" = "fixture" } # preserve\n';
  const result = configureCodexToolDiscovery(content);
  assert.equal(result.content, content);
  assert.equal(result.providerHeadersLine, 'http_headers = { "X-Custom" = "fixture" } # preserve');
  assert.deepEqual(readCodexToolDiscoveryStatus(content), { enabled: false, editable: false });
  for (const value of [true, false])
    assert.throws(() => configureCodexToolDiscovery(content, value), {
      code: 'invalid_codex_tool_discovery',
      statusCode: 400,
    });
});
test('quoted multiline content and comments cannot impersonate managed configuration', () => {
  for (const delimiter of ['"""', "'''"]) {
    const content = `instructions = ${delimiter}\n${table}\n${header}\n${delimiter}\n${initial}`;
    assert.deepEqual(readCodexToolDiscoveryStatus(content), { enabled: false, editable: true });
    assert.equal(configureCodexToolDiscovery(content).content, content);
  }
  for (const text of ['# """', "# '''", 'instructions = "escaped \\" quote"']) {
    assert.equal(readCodexToolDiscoveryStatus(text + '\n' + initial).editable, true);
  }
  assert.equal(readCodexToolDiscoveryStatus(initial + table + '\n# ' + header).enabled, false);
});
test('invalid, duplicate, oversized and unsupported state fails closed with content-free errors', () => {
  for (const value of [null, 'true', '', 0, 1, {}, [], 'SECRET\ntrue']) {
    assert.throws(
      () => validateCodexToolDiscoveryOption(value),
      (error) => error.code === 'invalid_codex_tool_discovery' && !error.message.includes('SECRET')
    );
  }
  assert.equal(validateCodexToolDiscoveryOption(undefined), undefined);
  for (const options of [
    null,
    false,
    'SECRET',
    [],
    1,
    Object.create({ toolDiscovery: true }),
    Object.defineProperty({}, 'toolDiscovery', {
      get() {
        throw new Error('Getter must not run');
      },
    }),
  ]) {
    assert.throws(() => validateCodexToolDiscoveryOptions(options), {
      code: 'invalid_codex_tool_discovery',
    });
  }
  assert.equal(validateCodexToolDiscoveryOptions(Object.create(null)), undefined);
  assert.equal(validateCodexToolDiscoveryOptions({ toolDiscovery: true }), true);
  for (const content of [
    null,
    [],
    {},
    initial + '\0',
    'x'.repeat(1024 * 1024 + 1),
    initial + table + '\n' + header + '\n' + header,
    initial + table + '\n' + table,
    initial + 'http_headers = {\n"X-Custom" = "fixture"\n}',
    initial + 'http_headers = {}\nhttp_headers = {}',
    initial + 'http_headers = {}\n' + table,
    'instructions = "unclosed',
    'instructions = """\nunclosed',
  ]) {
    assert.throws(() => configureCodexToolDiscovery(content, true), {
      code: 'invalid_codex_tool_discovery',
    });
    assert.deepEqual(readCodexToolDiscoveryStatus(content), { enabled: false, editable: false });
  }
  const foreign = initial + table + '\n"x-hpm-tool-discovery" = "foreign-capability"';
  assert.equal(readCodexToolDiscoveryStatus(foreign).enabled, false);
});
