const assert = require('assert');
const {
  LruCache,
  buildRouteIndex,
  lookupInIndex,
  createRouteIndex,
  resolveRouteWithIndex,
  _bucketKeyFor,
  _scoreFromPattern,
} = require('../lib/proxy/route-index');

// 1. LruCache basic ops
const c = new LruCache(3);
c.set('a', 1);
c.set('b', 2);
c.set('c', 3);
assert.strictEqual(c.get('a'), 1);
c.set('d', 4); // evicts 'b'
assert.strictEqual(c.has('a'), true);
assert.strictEqual(c.has('b'), false);
assert.strictEqual(c.has('c'), true);
assert.strictEqual(c.has('d'), true);
console.log('[route-index.test] LruCache eviction ok');

// 2. LruCache refreshes recency
c.clear();
c.set('x', 1);
c.set('y', 2);
c.set('z', 3);
c.get('x'); // touch
c.set('w', 4);
assert.strictEqual(c.has('x'), true);
assert.strictEqual(c.has('y'), false);
console.log('[route-index.test] LruCache recency ok');

// 3. Bucket key derivation
assert.strictEqual(_bucketKeyFor('gpt-4o'), 'gp');
assert.strictEqual(_bucketKeyFor('claude-3-opus'), 'cl');
assert.strictEqual(_bucketKeyFor('*'), '*');
assert.strictEqual(_bucketKeyFor('*-opus'), '*');
assert.strictEqual(_bucketKeyFor('g*'), 'g');
console.log('[route-index.test] bucket key ok');

// 4. Score ordering
assert.ok(_scoreFromPattern('gpt-4o') > _scoreFromPattern('gpt-4*'));
assert.ok(_scoreFromPattern('gpt-4*') > _scoreFromPattern('*'));
console.log('[route-index.test] score ordering ok');

// 5. Exact match wins over wildcards
const r1 = { from: 'gpt-4o', profileId: 'p1', to: 'openai/gpt-4o' };
const r2 = { from: 'gpt-4*', profileId: 'p2', to: 'openai/gpt-4-turbo' };
const r3 = { from: '*', profileId: 'p3', to: 'openai/default' };
const routes = [r1, r2, r3];
const idx = buildRouteIndex(routes);
let m = lookupInIndex(idx, 'gpt-4o');
assert.strictEqual(m.length, 3, 'gpt-4o should match 3 routes');
const scores = m.map((x) => x.score).sort((a, b) => b - a);
assert.strictEqual(scores[0], 10006, 'gpt-4o exact match should have highest score');
console.log('[route-index.test] exact > wildcard > global ok');

// 6. gpt-4-turbo matches gpt-4* and *
m = lookupInIndex(idx, 'gpt-4-turbo');
assert.strictEqual(m.length, 2);
assert.ok(m.find((x) => x.route === r2));
console.log('[route-index.test] prefix wildcard ok');

// 7. claude-3-opus matches only *
m = lookupInIndex(idx, 'claude-3-opus');
assert.strictEqual(m.length, 1);
assert.strictEqual(m[0].route, r3);
console.log('[route-index.test] fallback default ok');

// 8. createRouteIndex + findBest
const ri = createRouteIndex(routes, { cacheLimit: 100 });
const best1 = ri.findBest('gpt-4o');
assert.ok(best1);
assert.strictEqual(best1.entry.route, r1, 'best should be exact match r1');
const best2 = ri.findBest('gpt-4-turbo');
assert.strictEqual(best2.entry.route, r2);
const best3 = ri.findBest('claude-3-opus');
assert.strictEqual(best3.entry.route, r3);
console.log('[route-index.test] findBest ok');

// 9. Caching
ri.findBest('gpt-4o'); // hit
ri.findBest('gpt-4o');
assert.ok(ri.stats().cacheSize >= 1, 'cache populated');
console.log('[route-index.test] cache ok');

// 10. resolveRouteWithIndex
const profiles = [
  { id: 'p1', name: 'P1' },
  { id: 'p2', name: 'P2' },
  { id: 'p3', name: 'P3' },
];
const active = profiles[0];
const res1 = resolveRouteWithIndex('gpt-4o', ri, profiles, active);
assert.strictEqual(res1.profile.id, 'p1');
assert.strictEqual(res1.route, r1);
const res3 = resolveRouteWithIndex('claude-3-opus', ri, profiles, active);
assert.strictEqual(res3.profile.id, 'p3');
const fallback = resolveRouteWithIndex('claude-3-opus', null, profiles, active);
assert.strictEqual(fallback.profile, active);
console.log('[route-index.test] resolveRouteWithIndex ok');

// 11. Disabled routes are skipped
const r4 = { from: 'gpt-4o', profileId: 'p4', to: 'p4/gpt-4o', enabled: false };
const ri2 = createRouteIndex([r4], { cacheLimit: 10 });
const best4 = ri2.findBest('gpt-4o');
assert.strictEqual(best4, null, 'disabled route should not match');
console.log('[route-index.test] disabled skipped ok');

// 12. Mid-string wildcard: gpt-*-opus
const r5 = { from: 'gpt-*-opus', profileId: 'p5', to: 'p5/opus' };
const ri3 = createRouteIndex([r5], { cacheLimit: 10 });
const best5a = ri3.findBest('gpt-3-opus');
assert.ok(best5a, 'gpt-3-opus should match gpt-*-opus');
const best5b = ri3.findBest('gpt-3-sonnet');
assert.strictEqual(best5b, null, 'gpt-3-sonnet should not match');
console.log('[route-index.test] mid-string wildcard ok');

// 13. Empty / invalid input
const riEmpty = createRouteIndex([], { cacheLimit: 10 });
assert.strictEqual(riEmpty.findBest('gpt-4'), null);
assert.strictEqual(riEmpty.findBest(''), null);
console.log('[route-index.test] empty index ok');

// 14. Case-insensitive
const r6 = { from: 'GPT-4O', profileId: 'p6', to: 'p6/gpt-4o' };
const ri6 = createRouteIndex([r6], { cacheLimit: 10 });
assert.ok(ri6.findBest('gpt-4o'), 'lower-case query should match upper-case pattern');
assert.ok(ri6.findBest('GPT-4O'));
console.log('[route-index.test] case-insensitive ok');

// 15. Stats
const stats = ri.stats();
assert.ok(typeof stats.totalEntries === 'number');
assert.ok(typeof stats.buckets === 'number');
assert.ok(typeof stats.cacheSize === 'number');
console.log('[route-index.test] stats ok');

// 16. Rebuild
ri.rebuild([r1, r3]);
assert.strictEqual(ri.findBest('gpt-4-turbo').entry.route, r3);
assert.strictEqual(ri.findBest('gpt-4o').entry.route, r1);
console.log('[route-index.test] rebuild ok');

console.log('[route-index.test] ok');
