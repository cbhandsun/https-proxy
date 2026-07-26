'use strict';

const assert = require('assert');
const {
  MAX_ROUTING_INPUT_CHARS,
  MAX_ROUTING_PATTERN_CHARS,
  compileSafeRoutingPattern,
  safeRoutingPatternMatches,
} = require('../lib/proxy/safe-routing-pattern');

assert.strictEqual(compileSafeRoutingPattern('^glm_search_').ok, true);
assert.strictEqual(safeRoutingPatternMatches('^glm_search_', 'glm_search_web'), true);
assert.strictEqual(safeRoutingPatternMatches('^glm_search_', 'read_file'), false);

assert.strictEqual(compileSafeRoutingPattern('').ok, false);
assert.strictEqual(compileSafeRoutingPattern('(').ok, false);
assert.strictEqual(compileSafeRoutingPattern('(a+)+$').ok, false);
assert.strictEqual(compileSafeRoutingPattern('(a|aa)+$').ok, false);
assert.strictEqual(compileSafeRoutingPattern('a'.repeat(MAX_ROUTING_PATTERN_CHARS + 1)).ok, false);
assert.strictEqual(
  safeRoutingPatternMatches('^a+$', 'a'.repeat(MAX_ROUTING_INPUT_CHARS + 1)),
  false
);

console.log('[safe-routing-pattern.test] ok');
