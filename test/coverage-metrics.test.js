'use strict';

const assert = require('assert');
const { collectCoverageMetrics, percentage } = require('../lib/coverage-metrics');

assert.strictEqual(percentage(0, 0), 100);
assert.strictEqual(percentage(2, 3), 66.66);

const metrics = collectCoverageMetrics(
  {
    'safe.js': {
      s: { 0: 1, 1: 0, 2: 2 },
      statementMap: {
        0: { start: { line: 1 } },
        1: { start: { line: 2 } },
        2: { start: { line: 1 } },
      },
      f: { 0: 1, 1: 0 },
      b: { 0: [1, 0], 1: [2, 3] },
    },
    'ignored.js': {
      s: { 0: 0 },
      statementMap: { 0: { start: { line: 1 } } },
      f: { 0: 0 },
      b: { 0: [0, 0] },
    },
  },
  (filePath) => filePath === 'safe.js'
);

assert.deepStrictEqual(metrics.statements, { covered: 2, total: 3, percentage: 66.66 });
assert.deepStrictEqual(metrics.functions, { covered: 1, total: 2, percentage: 50 });
assert.deepStrictEqual(metrics.branches, { covered: 3, total: 4, percentage: 75 });
assert.deepStrictEqual(metrics.lines, { covered: 1, total: 2, percentage: 50 });

console.log('[coverage-metrics.test] ok');
