const assert = require('assert');
const { DEFAULT_CONFIG, resolveProfileProtocolVersion } = require('../lib/proxy/config');

let pass = 0,
  fail = 0;
function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok -', name);
  } catch (err) {
    fail += 1;
    console.error('  FAIL -', name, '\n   ', err.message);
  }
}

console.log('config protocolVersion tests');

// 1. Default profile has empty protocolVersion
const def = DEFAULT_CONFIG.profiles[0];
assert.strictEqual(
  typeof def.protocolVersion,
  'string',
  'default profile should have protocolVersion field'
);
assert.strictEqual(
  DEFAULT_CONFIG.protocolOptions.clientContextTokens,
  200000,
  'default client context window should leave room for Codex tools and output'
);

// 2. Explicit value wins
t('explicit protocolVersion is used', () => {
  const r = resolveProfileProtocolVersion({ protocol: 'claude', protocolVersion: '2024-01-01' });
  assert.strictEqual(r, '2024-01-01');
});

// 3. Whitespace is trimmed
t('whitespace trimmed', () => {
  const r = resolveProfileProtocolVersion({
    protocol: 'claude',
    protocolVersion: '  2024-01-01  ',
  });
  assert.strictEqual(r, '2024-01-01');
});

// 4. Default for claude
t('claude -> 2023-06-01', () => {
  assert.strictEqual(resolveProfileProtocolVersion({ protocol: 'claude' }), '2023-06-01');
});

// 5. Default for claude-desktop
t('claude-desktop -> 2023-06-01', () => {
  assert.strictEqual(resolveProfileProtocolVersion({ protocol: 'claude-desktop' }), '2023-06-01');
});

// 6. Default for openai-responses
t('openai-responses -> 2.0', () => {
  assert.strictEqual(resolveProfileProtocolVersion({ protocol: 'openai-responses' }), '2.0');
});

// 7. Default for openai / openai-chat
t('openai -> v1', () => {
  assert.strictEqual(resolveProfileProtocolVersion({ protocol: 'openai' }), 'v1');
  assert.strictEqual(resolveProfileProtocolVersion({ protocol: 'openai-chat' }), 'v1');
});

// 8. Default for gemini
t('gemini -> v1', () => {
  assert.strictEqual(resolveProfileProtocolVersion({ protocol: 'gemini' }), 'v1');
});

// 9. Unknown protocol -> empty
t('unknown protocol -> empty', () => {
  assert.strictEqual(resolveProfileProtocolVersion({ protocol: 'foobar' }), '');
});

// 10. Null / missing profile
t('null profile -> empty', () => {
  assert.strictEqual(resolveProfileProtocolVersion(null), '');
  assert.strictEqual(resolveProfileProtocolVersion(undefined), '');
  assert.strictEqual(resolveProfileProtocolVersion({}), '');
});

// 11. Custom string passes through
t('custom version string passes through', () => {
  assert.strictEqual(
    resolveProfileProtocolVersion({ protocol: 'claude', protocolVersion: 'beta-2024-12' }),
    'beta-2024-12'
  );
  assert.strictEqual(
    resolveProfileProtocolVersion({ protocol: 'openai', protocolVersion: 'gpt-4-0613' }),
    'gpt-4-0613'
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('config protocolVersion ok');
