'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const script = fs.readFileSync(
  path.join(__dirname, '../scripts/check-security-coverage.js'),
  'utf8'
);
const repoRoot = path.resolve(__dirname, '..');
const report = path.join(repoRoot, 'coverage', 'proxy', 'coverage-final.json');

function run(available) {
  const reads = [];
  vm.runInNewContext(script, {
    __dirname: path.join(repoRoot, 'scripts'),
    console: { log() {} },
    require(name) {
      if (name === 'fs')
        return {
          existsSync(file) {
            return available.has(file);
          },
          readFileSync(file) {
            reads.push(file);
            return '{}';
          },
        };
      if (name === 'path') return path;
      if (name === '../lib/coverage-metrics')
        return {
          collectCoverageMetrics() {
            return Object.fromEntries(
              ['statements', 'branches', 'functions', 'lines'].map((name) => [
                name,
                { percentage: 100 },
              ])
            );
          },
        };
      throw new Error('Unexpected dependency');
    },
  });
  return reads;
}

test('security coverage checks the report emitted by the isolated proxy coverage command', () => {
  assert.deepEqual(run(new Set([report])), [report]);
});

test('a stale legacy report cannot make a missing current report pass', () => {
  assert.throws(
    () => run(new Set([path.join(repoRoot, 'coverage', 'coverage-final.json')])),
    /Coverage report is missing/
  );
});
