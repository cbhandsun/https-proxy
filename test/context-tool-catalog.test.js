'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  TOOL_DISCOVERY_CAPABILITY,
  TOOL_DISCOVERY_NAME,
  MAX_DISCOVERY_ROUNDS,
  MAX_CATALOG_TOOLS,
  MAX_SCHEMA_BYTES,
  parseDiscoveryArguments,
  createContextToolCatalogStore,
} = require('../lib/proxy/context-tool-catalog');
const definition = (name, description = '查找证据🙂') => ({
  type: 'function',
  function: {
    name,
    description,
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'MUST preserve exact constraints',
          enum: ['原始🙂', 'b'],
        },
      },
      required: ['path'],
    },
  },
});
const body = (count = 20) => ({
  messages: [{ role: 'user', content: 'do not execute tools' }],
  tools: Array.from({ length: count }, (_entry, index) => definition(`tool_${index}`)),
});
const settings = (extra = {}) => ({
  owner: 'owner',
  scope: 'scope',
  capability: TOOL_DISCOVERY_CAPABILITY,
  initialNames: ['tool_0'],
  ...extra,
});
const call = (args, id = 'discover') => ({
  id,
  type: 'function',
  function: {
    name: TOOL_DISCOVERY_NAME,
    arguments: JSON.stringify(args),
  },
});
const stage = (catalog, args, id, signal) =>
  catalog.stage([call(args, id)], 'owner', 'scope', signal);
const publish = (catalog, value) => catalog.publish(value.ticket, () => ({ ok: true }));

test('negotiated catalogs retain exact schemas, page metadata and atomically load tools without executing them', () => {
  const store = createContextToolCatalogStore(),
    input = body();
  const opened = store.open(input, settings());
  assert.equal(opened.applied, true);
  assert.deepEqual(opened.body.tools[0], input.tools[0]);
  assert.equal(opened.body.tools.length, 2);
  input.tools[0].function.parameters.properties.path.enum.push('caller mutation');
  assert.deepEqual(opened.body.tools[0].function.parameters.properties.path.enum, ['原始🙂', 'b']);
  assert.ok(Object.isFrozen(opened.body.tools[0].function.parameters));
  const session = opened.catalog;
  const first = stage(session, { query: '' });
  assert.equal(first.ok, true);
  const page = JSON.parse(first.messages[0].content);
  assert.equal(page.tools.length, 8);
  assert.equal(page.nextOffset, 8);
  assert.equal(page.authority, 'untrusted_tool_metadata');
  assert.equal(session.stats().rounds, 0);
  assert.equal(publish(session, first).ok, true);
  assert.equal(publish(session, first).ok, true, 'exact publication retry is idempotent');
  const loaded = stage(session, { names: ['tool_10', 'tool_12'] }, 'next');
  assert.equal(
    session.tools('owner', 'scope').tools.length,
    2,
    'staged schemas are not yet active'
  );
  assert.deepEqual(
    loaded.tools.find((tool) => tool.function.name === 'tool_10'),
    input.tools[10]
  );
  assert.equal(publish(session, loaded).ok, true);
  assert.equal(session.tools('owner', 'scope').tools.length, 4);
  assert.equal(store.stats().entries, 1);
  session.close();
  assert.equal(store.stats().retainedBytes, 0);
  assert.equal(session.tools('owner', 'scope').reason, 'context_tool_catalog_unavailable');
});

test('unsupported clients, empty catalogs, none and reserved collisions fall back unchanged; forced choices remain exact', () => {
  const store = createContextToolCatalogStore();
  for (const [input, opts] of [
    [body(), settings({ capability: 'native-tool-reference' })],
    [body(0), settings()],
    [{ ...body(), tool_choice: 'none' }, settings()],
    [{ ...body(), tools: [definition(TOOL_DISCOVERY_NAME)] }, settings()],
    [{ ...body(), tools: [definition('hpm_read_context_artifact')] }, settings()],
  ]) {
    const result = store.open(input, opts);
    assert.equal(result.applied, false);
    assert.equal(result.body, input);
  }
  const input = { ...body(), tool_choice: { type: 'function', function: { name: 'tool_18' } } };
  const result = store.open(input, settings());
  assert.equal(result.body.tool_choice, input.tool_choice);
  assert.deepEqual(
    result.body.tools.find((tool) => tool.function.name === 'tool_18'),
    input.tools[18]
  );
  result.catalog.close();
  store.close();
});

test('catalogs are owner/scope bound, unique and foreign tickets cannot load schemas', () => {
  const store = createContextToolCatalogStore(),
    first = store.open(body(), settings());
  const second = store.open(body(), settings({ scope: 'second' }));
  assert.equal(store.open(body(), settings()).reason, 'context_tool_catalog_conflict');
  for (const [owner, scope] of [
    ['other', 'scope'],
    ['owner', 'other'],
  ]) {
    assert.equal(first.catalog.tools(owner, scope).ok, false);
    assert.equal(first.catalog.stage([call({ names: ['tool_1'] })], owner, scope).ok, false);
  }
  const ticket = stage(first.catalog, { names: ['tool_1'] });
  assert.equal(second.catalog.publish(ticket.ticket, () => ({ ok: true })).ok, false);
  assert.equal(first.catalog.publish({ ...ticket.ticket }, () => ({ ok: true })).ok, false);
  first.catalog.rollback(ticket.ticket);
  assert.equal(first.catalog.publish(ticket.ticket, () => ({ ok: true })).ok, false);
  assert.equal(
    stage(first.catalog, { names: ['not_authorized'] }).reason,
    'context_tool_catalog_unavailable'
  );
  store.close();
  assert.equal(store.stats().entries, 0);
});

test('normal, empty, illegal and extreme discovery arguments are bounded and parsed before lookup', () => {
  assert.deepEqual(parseDiscoveryArguments('{"query":"查找🙂"}'), { query: '查找🙂', offset: 0 });
  assert.deepEqual(parseDiscoveryArguments('{"query":""}'), { query: '', offset: 0 });
  for (const input of [
    null,
    '',
    '{}',
    'null',
    '[]',
    '{bad',
    '{"names":[]}',
    '{"names":["tool_1","tool_1"]}',
    '{"names":["../private"]}',
    '{"query":"x","names":["tool_1"]}',
    '{"query":"x","offset":-1}',
    '{"query":"x","offset":1.5}',
    '{"query":"x","unknown":true}',
    JSON.stringify({ query: 'x'.repeat(257) }),
    JSON.stringify({ query: 'x\n' }),
    JSON.stringify({ names: Array(5).fill('x') }),
    ' '.repeat(2049),
  ])
    assert.equal(parseDiscoveryArguments(input), null);
});

test('invalid, custom-prototype, sparse, cyclic and getter-backed catalogs fail without evaluating hooks', () => {
  const store = createContextToolCatalogStore();
  let reads = 0;
  const accessor = body();
  Object.defineProperty(accessor.tools[0].function, 'name', {
    enumerable: true,
    get() {
      reads++;
      throw new Error('private accessor');
    },
  });
  const topAccessor = {};
  Object.defineProperty(topAccessor, 'tools', {
    enumerable: true,
    get() {
      reads++;
      throw new Error('private body accessor');
    },
  });
  const cyclic = body();
  cyclic.tools[0].function.parameters.cycle = cyclic;
  for (const input of [
    accessor,
    topAccessor,
    cyclic,
    { ...body(), tools: new Array(20) },
    { ...body(), tools: [new Date()] },
    { ...body(), tools: [definition('duplicate'), definition('duplicate')] },
    { ...body(), tools: [definition('bad name')] },
    { ...body(), tools: [{ ...definition('x'), type: 'web_search' }] },
    { ...body(), tools: [{ type: 'function', function: { name: 'x', parameters: null } }] },
    body(MAX_CATALOG_TOOLS + 1),
    { ...body(), tools: [definition('x', 'a'.repeat(MAX_SCHEMA_BYTES))] },
  ])
    assert.equal(store.open(input, settings()).applied, false);
  assert.equal(reads, 0);
  assert.equal(store.stats().retainedBytes, 0);
  const opened = store.open(body(), settings());
  const tainted = call({ names: ['tool_1'] });
  Object.defineProperty(tainted, 'function', {
    enumerable: true,
    get() {
      reads++;
      throw new Error('private call accessor');
    },
  });
  assert.equal(opened.catalog.stage([tainted], 'owner', 'scope').ok, false);
  assert.equal(reads, 0);
  store.close();
});

test('failed publishers, exceptions, cancellation and reentrancy leave the catalog unchanged', () => {
  const store = createContextToolCatalogStore(),
    session = store.open(body(), settings()).catalog;
  for (const mode of ['false', 'throw', 'getter', 'cancel']) {
    const controller = new globalThis.AbortController();
    const planned = stage(session, { names: ['tool_2'] }, mode, controller.signal);
    let calls = 0;
    if (mode === 'cancel') controller.abort();
    const run = () =>
      session.publish(planned.ticket, () => {
        calls++;
        if (mode === 'throw') throw new Error('publisher failure');
        if (mode === 'getter')
          return {
            get ok() {
              throw new Error('must not invoke getter');
            },
          };
        return { ok: false };
      });
    if (mode === 'throw') assert.throws(run, /publisher failure/);
    else assert.equal(run().ok, false);
    session.rollback(planned.ticket);
    assert.equal(session.stats().loadedTools, 1);
    assert.equal(session.stats().pending, false);
    if (mode === 'cancel') assert.equal(calls, 0);
  }
  const planned = stage(session, { names: ['tool_2'] });
  assert.equal(
    session.publish(planned.ticket, () => {
      assert.equal(session.close(), false);
      assert.equal(store.close(), false);
      assert.equal(stage(session, { query: 'x' }).reason, 'context_tool_catalog_busy');
      return { ok: true };
    }).ok,
    true
  );
  assert.equal(session.stats().loadedTools, 2);
  store.close();
});

test('discovery fingerprints reject loops and duplicate turns, and a hard round limit remains bounded', () => {
  const store = createContextToolCatalogStore(),
    session = store.open(body(80), settings()).catalog;
  assert.equal(
    session.stage([call({ query: '' }), call({ query: '' }, 'two')], 'owner', 'scope').reason,
    'context_tool_discovery_loop'
  );
  assert.equal(
    session.stage([call({ query: '' }), call({ query: 'x' })], 'owner', 'scope').reason,
    'context_tool_discovery_invalid_turn'
  );
  for (let index = 0; index < MAX_DISCOVERY_ROUNDS; index++) {
    const planned = stage(session, { query: '', offset: index * 8 }, `page_${index}`);
    assert.equal(planned.ok, true);
    assert.equal(publish(session, planned).ok, true);
    if (index === 0)
      assert.equal(stage(session, { query: '' }).reason, 'context_tool_discovery_loop');
  }
  assert.equal(stage(session, { query: '', offset: 64 }).reason, 'context_tool_discovery_limit');
  store.close();
});

test('owner, global, entry, expiry and clock-skew quotas reclaim catalog memory', () => {
  let now = 100;
  const store = createContextToolCatalogStore({ now: () => now, ttlMs: 10 });
  const big = {
    ...body(),
    tools: Array.from({ length: 15 }, (_entry, index) =>
      definition(`tool_${index}`, 'x'.repeat(125000))
    ),
  };
  for (let index = 0; index < 4; index++)
    assert.equal(store.open(big, settings({ scope: `large_${index}` })).applied, true);
  assert.equal(store.open(big, settings({ scope: 'quota' })).reason, 'context_tool_catalog_quota');
  assert.equal(store.open(big, settings({ owner: 'other', scope: 'other' })).applied, true);
  now = 110;
  assert.equal(store.stats().entries, 0);
  assert.equal(store.stats().retainedBytes, 0);
  const session = store.open(body(), settings()).catalog;
  now = 90;
  assert.equal(session.tools('owner', 'scope').ok, false);
  assert.equal(store.stats().retainedBytes, 0);
  now = 120;
  for (let index = 0; index < 64; index++)
    assert.equal(store.open(body(1), settings({ scope: String(index) })).applied, true);
  assert.equal(
    store.open(body(1), settings({ scope: 'overflow' })).reason,
    'context_tool_catalog_quota'
  );
  store.close();
  assert.equal(store.open(body(), settings()).applied, false);
});

test('loaded-schema and process-wide byte limits reject atomically and released quota is reusable', () => {
  const store = createContextToolCatalogStore();
  const opened = store.open(
    body(40),
    settings({ initialNames: Array.from({ length: 32 }, (_entry, index) => `tool_${index}`) })
  );
  assert.equal(opened.applied, true);
  assert.equal(stage(opened.catalog, { names: ['tool_32'] }).reason, 'context_tool_schema_limit');
  assert.equal(opened.catalog.stats().loadedTools, 32);
  assert.equal(opened.catalog.stats().pending, false);
  opened.catalog.close();
  const big = {
    ...body(),
    tools: Array.from({ length: 15 }, (_entry, index) =>
      definition(`tool_${index}`, 'x'.repeat(125000))
    ),
  };
  const sessions = [];
  for (let index = 0; index < 8; index++) {
    const result = store.open(big, settings({ owner: `owner_${index}`, scope: `scope_${index}` }));
    assert.equal(result.applied, true);
    sessions.push(result.catalog);
  }
  assert.equal(
    store.open(big, settings({ owner: 'ninth', scope: 'ninth' })).reason,
    'context_tool_catalog_quota'
  );
  sessions[0].close();
  assert.equal(store.open(big, settings({ owner: 'ninth', scope: 'ninth' })).applied, true);
  store.close();
  assert.equal(store.stats().retainedBytes, 0);
});

test('committed discovery IDs remain reserved, failed stages remain retryable and precise history conflicts are preserved', () => {
  const store = createContextToolCatalogStore(),
    session = store.open(body(), settings()).catalog;
  const first = stage(session, { names: ['tool_1'] }, 'committed_id');
  assert.equal(publish(session, first).ok, true);
  assert.equal(
    stage(session, { names: ['tool_2'] }, 'committed_id').reason,
    'context_tool_discovery_invalid_turn'
  );
  const rejected = stage(session, { names: ['tool_2'] }, 'retry_id');
  assert.equal(
    session.publish(rejected.ticket, () => ({
      ok: false,
      reason: 'context_history_version_conflict',
    })).reason,
    'context_history_version_conflict'
  );
  const retry = stage(session, { names: ['tool_2'] }, 'retry_id');
  assert.equal(retry.ok, true);
  assert.equal(publish(session, retry).ok, true);
  store.close();
});

test('negotiation rejects accessor-backed choice, names, symbol metadata and unknown options without executing them', () => {
  const store = createContextToolCatalogStore();
  let reads = 0;
  const initialNames = ['tool_0'];
  Object.defineProperty(initialNames, '0', {
    get() {
      reads++;
      return 'tool_0';
    },
  });
  assert.equal(store.open(body(), settings({ initialNames })).applied, false);
  assert.equal(store.open(body(), settings({ initialNames: new Array(2) })).applied, false);
  const choice = {
    type: 'function',
    function: {
      get name() {
        reads++;
        return 'tool_0';
      },
    },
  };
  assert.equal(store.open({ ...body(), tool_choice: choice }, settings()).applied, false);
  const metadata = body();
  Object.defineProperty(metadata, Symbol('untrusted'), {
    get() {
      reads++;
      return {};
    },
  });
  assert.equal(store.open(metadata, settings()).applied, false);
  assert.throws(() => createContextToolCatalogStore({ unknown: true }), TypeError);
  assert.throws(() => store.open(body(), settings({ unknown: true })), TypeError);
  assert.equal(reads, 0);
  assert.equal(parseDiscoveryArguments('{"query":"x","offset":null}'), null);
  store.close();
});
