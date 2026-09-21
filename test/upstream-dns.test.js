'use strict';

const assert = require('node:assert/strict');

const {
  DEFAULT_DNS_SERVERS,
  MAX_DNS_SERVERS,
  ADDRESS_UNTRUSTWORTHY_ERROR_CODES,
  isUntrustworthyAddressError,
  isPublicAddress,
  shouldUseSystemResolver,
  parseDnsServerList,
  createUpstreamResolver,
} = require('../lib/proxy/upstream-dns');

function assertThrowsTypeError(fn, pattern) {
  assert.throws(fn, (error) => error instanceof TypeError && pattern.test(error.message));
}

/** 造一个可编程的假 Resolver：按服务器与查询类型预置答案或错误。 */
function createFakeResolverFactory(plans) {
  const calls = [];
  const createResolver = () => {
    let servers = [];
    return {
      setServers(next) {
        servers = [...next];
      },
      resolve4(hostname, options) {
        calls.push({ type: 'A', hostname, servers: [...servers], options });
        const plan = plans[`${servers[0]}|A`];
        if (plan === undefined)
          return Promise.reject(Object.assign(new Error('no plan'), { code: 'ENOTFOUND' }));
        if (plan instanceof Error) return Promise.reject(plan);
        return Promise.resolve(plan);
      },
      resolve6(hostname, options) {
        calls.push({ type: 'AAAA', hostname, servers: [...servers], options });
        const plan = plans[`${servers[0]}|AAAA`];
        if (plan === undefined)
          return Promise.reject(Object.assign(new Error('no plan'), { code: 'ENOTFOUND' }));
        if (plan instanceof Error) return Promise.reject(plan);
        return Promise.resolve(plan);
      },
      cancel() {
        calls.push({ type: 'cancel', servers: [...servers] });
      },
    };
  };
  return { createResolver, calls };
}

function lookupPromise(resolver, hostname, options) {
  return new Promise((resolve, reject) => {
    resolver.lookup(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

async function testDefaultServerList() {
  assert.deepStrictEqual([...DEFAULT_DNS_SERVERS], ['1.1.1.1', '8.8.8.8', '223.5.5.5']);
}

async function testParseServerListAcceptsArrayAndString() {
  assert.deepStrictEqual(parseDnsServerList(['1.1.1.1', '8.8.8.8']), {
    servers: ['1.1.1.1', '8.8.8.8'],
    invalid: [],
  });
  assert.deepStrictEqual(parseDnsServerList('1.1.1.1, 223.5.5.5'), {
    servers: ['1.1.1.1', '223.5.5.5'],
    invalid: [],
  });
  assert.deepStrictEqual(parseDnsServerList(['2606:4700:4700::1111']), {
    servers: ['2606:4700:4700::1111'],
    invalid: [],
  });
}

async function testParseServerListRejectsEmptyInvalidAndDuplicateEntries() {
  assert.deepStrictEqual(parseDnsServerList(null), { servers: [], invalid: [] });
  assert.deepStrictEqual(parseDnsServerList(''), { servers: [], invalid: [] });
  assert.deepStrictEqual(parseDnsServerList([]), { servers: [], invalid: [] });
  assert.deepStrictEqual(parseDnsServerList(['1.1.1.1', '1.1.1.1']), {
    servers: ['1.1.1.1'],
    invalid: [],
  });
  assert.deepStrictEqual(parseDnsServerList(['1.1.1.1', 'not-an-ip', '1.1.1.1.1', '8.8.8.8', '']), {
    servers: ['1.1.1.1', '8.8.8.8'],
    invalid: ['not-an-ip', '1.1.1.1.1'],
  });
}

async function testParseServerListBoundsEntryCount() {
  const many = Array.from({ length: 64 }, (_value, index) => `10.0.0.${index + 1}`);
  const parsed = parseDnsServerList(many);
  assert.strictEqual(parsed.servers.length, MAX_DNS_SERVERS);
  assert.deepStrictEqual(parsed.invalid, []);
}

async function testPublicAddressClassification() {
  assert.strictEqual(isPublicAddress('104.18.32.47', 4), true);
  assert.strictEqual(isPublicAddress('223.5.5.5'), true);

  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.5.5',
    '192.0.2.5',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ]) {
    assert.strictEqual(isPublicAddress(address, 4), false, `${address} must be non-public`);
  }

  assert.strictEqual(isPublicAddress('2606:4700:4700::1111', 6), true);
  assert.strictEqual(isPublicAddress('::1', 6), false);
  assert.strictEqual(isPublicAddress('::', 6), false);
  assert.strictEqual(isPublicAddress('fd00::1', 6), false);
  assert.strictEqual(isPublicAddress('fe80::1', 6), false);
  assert.strictEqual(isPublicAddress('ff02::1', 6), false);
  assert.strictEqual(isPublicAddress('2001:db8::1', 6), false);
  assert.strictEqual(isPublicAddress('::ffff:10.0.0.1', 6), false);
  assert.strictEqual(isPublicAddress('::ffff:104.18.32.47', 6), true);

  assert.strictEqual(isPublicAddress('not-an-address'), false);
  assert.strictEqual(isPublicAddress('', 4), false);
  assert.strictEqual(isPublicAddress(null), false);
}

async function testLocalNamesUseSystemResolver() {
  for (const host of ['localhost', 'fileserver', 'printer.local', 'db.internal', 'app.corp']) {
    assert.strictEqual(shouldUseSystemResolver(host), true, `${host} must use system resolver`);
  }
  for (const host of ['chatgpt.com', 'api.openai.com', 'sub.domain.co.uk']) {
    assert.strictEqual(shouldUseSystemResolver(host), false, `${host} must use trusted servers`);
  }
  assert.strictEqual(shouldUseSystemResolver(''), true);
  assert.strictEqual(shouldUseSystemResolver(null), true);
}

async function testUntrustworthyErrorClassification() {
  assert.strictEqual(isUntrustworthyAddressError('ERR_TLS_CERT_ALTNAME_INVALID'), true);
  assert.strictEqual(isUntrustworthyAddressError('err_tls_cert_altname_invalid'), true);
  assert.strictEqual(isUntrustworthyAddressError('  CERT_HAS_EXPIRED  '), true);
  assert.strictEqual(isUntrustworthyAddressError('ECONNRESET'), false);
  assert.strictEqual(isUntrustworthyAddressError('EPIPE'), false);
  assert.strictEqual(isUntrustworthyAddressError('ETIMEDOUT'), false);
  assert.strictEqual(isUntrustworthyAddressError(undefined), false);
  assert.strictEqual(isUntrustworthyAddressError(null), false);
  assert.strictEqual(ADDRESS_UNTRUSTWORTHY_ERROR_CODES.has('ECONNREFUSED'), true);
}

async function testResolverFallsBackToSecondServer() {
  const { createResolver, calls } = createFakeResolverFactory({
    '1.1.1.1|A': Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    '8.8.8.8|A': [{ address: '104.18.32.47', ttl: 60 }],
  });
  const resolver = createUpstreamResolver({
    servers: ['1.1.1.1', '8.8.8.8'],
    createResolver,
    logger: null,
  });
  const result = await lookupPromise(resolver, 'chatgpt.com', { family: 4 });
  assert.deepStrictEqual(result, { address: '104.18.32.47', family: 4 });
  assert.ok(calls.some((call) => call.servers[0] === '1.1.1.1'));
  assert.ok(calls.some((call) => call.servers[0] === '8.8.8.8'));
}

async function testResolverPrefersFirstServerOrder() {
  const { createResolver } = createFakeResolverFactory({
    '223.5.5.5|A': [{ address: '203.0.113.10', ttl: 60 }],
    '1.1.1.1|A': [{ address: '104.18.32.47', ttl: 60 }],
  });
  const resolver = createUpstreamResolver({ servers: ['1.1.1.1', '223.5.5.5'], createResolver });
  const result = await lookupPromise(resolver, 'chatgpt.com', { family: 4 });
  assert.strictEqual(result.address, '104.18.32.47');
}

async function testResolverDropsNonPublicAnswers() {
  const { createResolver } = createFakeResolverFactory({
    '1.1.1.1|A': [
      { address: '10.0.0.9', ttl: 60 },
      { address: '127.0.0.1', ttl: 60 },
      { address: '104.18.32.47', ttl: 60 },
    ],
  });
  const resolver = createUpstreamResolver({ servers: ['1.1.1.1'], createResolver });
  const result = await lookupPromise(resolver, 'chatgpt.com', { family: 4 });
  assert.strictEqual(result.address, '104.18.32.47');
}

async function testResolverTreatsAllPrivateAnswersAsFailure() {
  const { createResolver } = createFakeResolverFactory({
    '1.1.1.1|A': [{ address: '192.168.1.1', ttl: 60 }],
    '8.8.8.8|A': [{ address: '10.0.0.1', ttl: 60 }],
  });
  const systemCalls = [];
  const resolver = createUpstreamResolver({
    servers: ['1.1.1.1', '8.8.8.8'],
    createResolver,
    systemLookup: (hostname, options, callback) => {
      systemCalls.push({ hostname, options });
      callback(null, '104.18.32.47', 4);
    },
  });
  const result = await lookupPromise(resolver, 'chatgpt.com', { family: 4 });
  assert.deepStrictEqual(result, { address: '104.18.32.47', family: 4 });
  assert.strictEqual(systemCalls.length, 1);
}

async function testResolverFallsBackToSystemWhenAllServersFail() {
  const { createResolver } = createFakeResolverFactory({
    '1.1.1.1|A': Object.assign(new Error('servfail'), { code: 'ESERVFAIL' }),
    '8.8.8.8|A': Object.assign(new Error('refused'), { code: 'EREFUSED' }),
  });
  const systemCalls = [];
  const resolver = createUpstreamResolver({
    servers: ['1.1.1.1', '8.8.8.8'],
    createResolver,
    systemLookup: (hostname, options, callback) => {
      systemCalls.push(hostname);
      callback(null, '172.64.155.209', 4);
    },
  });
  const result = await lookupPromise(resolver, 'chatgpt.com', { family: 4 });
  assert.strictEqual(result.address, '172.64.155.209');
  assert.deepStrictEqual(systemCalls, ['chatgpt.com']);
}

async function testResolverEmptyServerListUsesSystemResolution() {
  let trustedQueries = 0;
  const resolver = createUpstreamResolver({
    servers: [],
    createResolver: () => {
      trustedQueries += 1;
      throw new Error('trusted resolver must not be created');
    },
    systemLookup: (hostname, options, callback) => callback(null, '104.18.32.47', 4),
  });
  const result = await lookupPromise(resolver, 'chatgpt.com', { family: 4 });
  assert.deepStrictEqual(result, { address: '104.18.32.47', family: 4 });
  assert.strictEqual(trustedQueries, 0);
}

async function testResolverLocalNamesUseSystemResolution() {
  let trustedQueries = 0;
  const systemHosts = [];
  const resolver = createUpstreamResolver({
    servers: ['1.1.1.1'],
    createResolver: () => {
      trustedQueries += 1;
      throw new Error('trusted resolver must not be created for local names');
    },
    systemLookup: (hostname, options, callback) => {
      systemHosts.push(hostname);
      callback(null, '127.0.0.1', 4);
    },
  });
  await lookupPromise(resolver, 'fileserver', {});
  await lookupPromise(resolver, 'printer.local', {});
  assert.strictEqual(trustedQueries, 0);
  assert.deepStrictEqual(systemHosts, ['fileserver', 'printer.local']);
}

async function testResolverSkipsLookupForIpLiterals() {
  let trustedQueries = 0;
  let systemCalls = 0;
  const resolver = createUpstreamResolver({
    servers: ['1.1.1.1'],
    createResolver: () => {
      trustedQueries += 1;
      throw new Error('must not query for an IP literal');
    },
    systemLookup: () => {
      systemCalls += 1;
    },
  });
  const ipv4 = await lookupPromise(resolver, '104.18.32.47', {});
  const ipv6 = await lookupPromise(resolver, '::1', {});
  assert.deepStrictEqual(ipv4, { address: '104.18.32.47', family: 4 });
  assert.deepStrictEqual(ipv6, { address: '::1', family: 6 });
  assert.strictEqual(trustedQueries, 0);
  assert.strictEqual(systemCalls, 0);
}

async function testResolverCacheAvoidsRepeatQueries() {
  const { createResolver, calls } = createFakeResolverFactory({
    '1.1.1.1|A': [{ address: '104.18.32.47', ttl: 120 }],
  });
  const resolver = createUpstreamResolver({
    servers: ['1.1.1.1'],
    createResolver,
    cacheTtlMs: 60000,
  });
  await lookupPromise(resolver, 'chatgpt.com', { family: 4 });
  const afterFirst = calls.length;
  await lookupPromise(resolver, 'chatgpt.com', { family: 4 });
  assert.strictEqual(calls.length, afterFirst);
  assert.strictEqual(resolver.cacheSize(), 1);
}

async function testResolverInvalidateForcesFreshQuery() {
  const { createResolver, calls } = createFakeResolverFactory({
    '1.1.1.1|A': [{ address: '104.18.32.47', ttl: 120 }],
  });
  const resolver = createUpstreamResolver({ servers: ['1.1.1.1'], createResolver });
  await lookupPromise(resolver, 'chatgpt.com', { family: 4 });
  const afterFirst = calls.length;
  assert.strictEqual(resolver.invalidate('chatgpt.com'), true);
  assert.strictEqual(resolver.cacheSize(), 0);
  await lookupPromise(resolver, 'chatgpt.com', { family: 4 });
  assert.ok(calls.length > afterFirst);
  assert.strictEqual(resolver.invalidate('unknown.example'), false);
  assert.strictEqual(resolver.invalidate(''), false);
}

async function testResolverCacheExpires() {
  let clock = 0;
  const { createResolver, calls } = createFakeResolverFactory({
    '1.1.1.1|A': [{ address: '104.18.32.47', ttl: 1 }],
  });
  const resolver = createUpstreamResolver({
    servers: ['1.1.1.1'],
    createResolver,
    cacheTtlMs: 60000,
    now: () => clock,
  });
  await lookupPromise(resolver, 'chatgpt.com', { family: 4 });
  const afterFirst = calls.length;
  clock = 2000;
  await lookupPromise(resolver, 'chatgpt.com', { family: 4 });
  assert.ok(calls.length > afterFirst);
}

async function testResolverCapsCacheEntries() {
  const { createResolver, calls } = createFakeResolverFactory({
    '1.1.1.1|A': [{ address: '104.18.32.47', ttl: 120 }],
  });
  const resolver = createUpstreamResolver({
    servers: ['1.1.1.1'],
    createResolver,
    maxCacheEntries: 1,
  });
  await lookupPromise(resolver, 'a.example', { family: 4 });
  await lookupPromise(resolver, 'b.example', { family: 4 });
  assert.strictEqual(resolver.cacheSize(), 1);
  const before = calls.length;
  await lookupPromise(resolver, 'a.example', { family: 4 });
  assert.ok(calls.length > before);
}

async function testResolverHonoursFamilyAndAllFlag() {
  const { createResolver, calls } = createFakeResolverFactory({
    '1.1.1.1|A': [{ address: '104.18.32.47', ttl: 60 }],
    '1.1.1.1|AAAA': [{ address: '2606:4700:4700::1111', ttl: 60 }],
  });
  const resolver = createUpstreamResolver({ servers: ['1.1.1.1'], createResolver });
  const all = await new Promise((resolve, reject) => {
    resolver.lookup('chatgpt.com', { all: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses)
    );
  });
  assert.ok(all.length >= 1);
  for (const entry of all) {
    assert.strictEqual(typeof entry.address, 'string');
    assert.ok(entry.family === 4 || entry.family === 6);
  }
  assert.ok(calls.some((call) => call.type === 'A'));
}

async function testResolverFamilySixOnlyQueriesAaaa() {
  const { createResolver, calls } = createFakeResolverFactory({
    '1.1.1.1|AAAA': [{ address: '2606:4700:4700::1111', ttl: 60 }],
  });
  const resolver = createUpstreamResolver({ servers: ['1.1.1.1'], createResolver });
  const result = await lookupPromise(resolver, 'chatgpt.com', { family: 6 });
  assert.deepStrictEqual(result, { address: '2606:4700:4700::1111', family: 6 });
  assert.deepStrictEqual(
    calls.filter((call) => call.type === 'A'),
    []
  );
}

async function testResolverTimesOutSlowServers() {
  const cancelled = [];
  const resolver = createUpstreamResolver({
    servers: ['1.1.1.1'],
    queryTimeoutMs: 50,
    createResolver: () => ({
      setServers() {},
      resolve4: () => new Promise(() => {}),
      resolve6: () => new Promise(() => {}),
      cancel() {
        cancelled.push(true);
      },
    }),
    systemLookup: (hostname, options, callback) => callback(null, '104.18.32.47', 4),
  });
  const result = await lookupPromise(resolver, 'chatgpt.com', { family: 4 });
  assert.strictEqual(result.address, '104.18.32.47');
  assert.ok(cancelled.length >= 1);
}

async function testResolverBoundsTimeoutAndTtlOptions() {
  const { createResolver, calls } = createFakeResolverFactory({
    '1.1.1.1|A': [{ address: '104.18.32.47', ttl: 999999 }],
  });
  const resolver = createUpstreamResolver({
    servers: ['1.1.1.1'],
    createResolver,
    queryTimeoutMs: -5,
    cacheTtlMs: 1,
    maxCacheEntries: -3,
  });
  const result = await lookupPromise(resolver, 'chatgpt.com', { family: 4 });
  assert.strictEqual(result.address, '104.18.32.47');
  assert.ok(calls.length >= 1);
}

async function testResolverRejectsInvalidDependencies() {
  assertThrowsTypeError(() => createUpstreamResolver({ systemLookup: null }), /systemLookup/);
  assertThrowsTypeError(() => createUpstreamResolver({ createResolver: 'nope' }), /createResolver/);
  const resolver = createUpstreamResolver({ servers: ['1.1.1.1'] });
  assert.throws(() => resolver.lookup('chatgpt.com', {}), /callback/);
}

async function main() {
  await testDefaultServerList();
  await testParseServerListAcceptsArrayAndString();
  await testParseServerListRejectsEmptyInvalidAndDuplicateEntries();
  await testParseServerListBoundsEntryCount();
  await testPublicAddressClassification();
  await testLocalNamesUseSystemResolver();
  await testUntrustworthyErrorClassification();
  await testResolverFallsBackToSecondServer();
  await testResolverPrefersFirstServerOrder();
  await testResolverDropsNonPublicAnswers();
  await testResolverTreatsAllPrivateAnswersAsFailure();
  await testResolverFallsBackToSystemWhenAllServersFail();
  await testResolverEmptyServerListUsesSystemResolution();
  await testResolverLocalNamesUseSystemResolution();
  await testResolverSkipsLookupForIpLiterals();
  await testResolverCacheAvoidsRepeatQueries();
  await testResolverInvalidateForcesFreshQuery();
  await testResolverCacheExpires();
  await testResolverCapsCacheEntries();
  await testResolverHonoursFamilyAndAllFlag();
  await testResolverFamilySixOnlyQueriesAaaa();
  await testResolverTimesOutSlowServers();
  await testResolverBoundsTimeoutAndTtlOptions();
  await testResolverRejectsInvalidDependencies();
  console.log('[upstream-dns.test] ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
