const assert = require('assert');
const {
  sanitizeRawValue,
  sanitizeRawStreamEvent,
  makeRawEventKey,
  normalizeRawKey,
} = require('../tools/trae-openai-bridge-extension/extension-sanitize');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ok -', name); }
  catch (err) { fail += 1; console.error('  FAIL -', name, '\n   ', err.message); }
}

console.log('extension-sanitize golden tests');

// 1. normalizeRawKey strips non-alphanumeric and lowercases
t('normalizeRawKey strips separators', () => {
  assert.strictEqual(normalizeRawKey('Authorization'), 'authorization');
  assert.strictEqual(normalizeRawKey('X-API-Key'), 'xapikey');
  assert.strictEqual(normalizeRawKey('session_id'), 'sessionid');
});

// 2. Sensitive keys are redacted
t('authorization -> [redacted]', () => {
  assert.strictEqual(sanitizeRawValue('Bearer xyz', 'authorization'), '[redacted]');
});
t('apiKey -> [redacted]', () => {
  assert.strictEqual(sanitizeRawValue('sk-123', 'apiKey'), '[redacted]');
});
t('x-api-key -> [redacted]', () => {
  assert.strictEqual(sanitizeRawValue('k', 'x-api-key'), '[redacted]');
});
t('password -> [redacted]', () => {
  assert.strictEqual(sanitizeRawValue('secret', 'password'), '[redacted]');
});
t('AK / SK patterns redacted', () => {
  assert.strictEqual(sanitizeRawValue('xx', 'AK'), '[redacted]');
  assert.strictEqual(sanitizeRawValue('xx', 'sk'), '[redacted]');
  assert.strictEqual(sanitizeRawValue('xx', 'access-key'), '[redacted]');
});

// 3. Long strings truncated
t('long string truncated to 500 + remainder', () => {
  const long = 'x'.repeat(1000);
  const out = sanitizeRawValue(long, 'reasoning');
  assert.ok(out.redacted, 'should mark as redacted');
  assert.strictEqual(out.chars, 1000);
});
t('medium string not truncated when in text field', () => {
  const out = sanitizeRawValue('hello world', 'foo_bar');
  assert.strictEqual(out, 'hello world');
});
t('500+ char string truncated', () => {
  const long = 'a'.repeat(1000);
  const out = sanitizeRawValue(long, 'status_msg');
  assert.ok(out.endsWith('[truncated 500 chars]'), 'should end with truncation marker, got: ' + out.slice(-50));
  assert.ok(out.length < 600, 'should be shorter than original');
});

// 4. Arrays sliced to 20 + remainder marker
t('array sliced to 20 + remainder', () => {
  const arr = Array.from({ length: 30 }, (_, i) => i);
  const out = sanitizeRawValue(arr, 'items');
  assert.strictEqual(out.length, 21);
  assert.strictEqual(out[20], '[truncated 10 items]');
});

// 5. Object keys capped at 80
t('object keys capped at 80 + __truncatedKeys marker', () => {
  const obj = {};
  for (let i = 0; i < 100; i += 1) obj['k' + i] = 'v' + i;
  const out = sanitizeRawValue(obj, 'payload');
  const realKeys = Object.keys(out).filter((k) => k !== '__truncatedKeys');
  assert.strictEqual(realKeys.length, 80);
  assert.strictEqual(out.__truncatedKeys, 20);
});

// 6. Max depth returns [max-depth]
t('depth 4 returns [max-depth]', () => {
  let v = { a: 1 };
  for (let i = 0; i < 5; i += 1) v = { x: v };
  const out = sanitizeRawValue(v, 'nested', 0);
  assert.ok(out.x.x.x.x === '[max-depth]' || out.x.x.x.x.x === '[max-depth]');
});

// 7. Safe raw text keys preserve the text
t('safe raw text keys are not redacted', () => {
  assert.strictEqual(sanitizeRawValue('plan_complete', 'event'), 'plan_complete');
  assert.strictEqual(sanitizeRawValue('running', 'status'), 'running');
  assert.strictEqual(sanitizeRawValue('gpt-4', 'model_name'), 'gpt-4');
});

// 8. sanitizeRawStreamEvent produces clean envelope
t('sanitizeRawStreamEvent builds envelope', () => {
  const event = {
    ts: 12345,
    service: 'chat',
    method: 'chat',
    channelId: 'c1',
    sessionId: 's1',
    agentMessageId: 'm1',
    event: 'plan_item',
    payload: { id: 'p1', tool_call_info: { id: 'tc1', name: 'Bash' } },
  };
  const out = sanitizeRawStreamEvent(event);
  assert.strictEqual(out.ts, 12345);
  assert.strictEqual(out.event, 'plan_item');
  assert.strictEqual(out.payload.id, 'p1');
  assert.strictEqual(out.payload.tool_call_info.id, 'tc1');
  assert.strictEqual(out.payload.tool_call_info.name, 'Bash');
});

// 9. Null / non-object event
t('null event produces minimal envelope', () => {
  const out = sanitizeRawStreamEvent(null);
  assert.strictEqual(out.event, '');
  assert.strictEqual(typeof out.ts, 'number');
});

// 10. makeRawEventKey is stable for same content
t('makeRawEventKey stable for same content', () => {
  const e1 = { ts: 1, service: 's', method: 'm', event: 'plan_item', payload: { id: 'p1' } };
  const e2 = { ts: 1, service: 's', method: 'm', event: 'plan_item', payload: { id: 'p1' } };
  assert.strictEqual(makeRawEventKey(e1), makeRawEventKey(e2));
});
t('makeRawEventKey differs for different ids', () => {
  const e1 = { ts: 1, event: 'plan_item', payload: { id: 'p1' } };
  const e2 = { ts: 1, event: 'plan_item', payload: { id: 'p2' } };
  assert.notStrictEqual(makeRawEventKey(e1), makeRawEventKey(e2));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('extension-sanitize tests ok');
