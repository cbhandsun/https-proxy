'use strict';

const fs = require('fs');
const path = require('path');
const { collectCoverageMetrics } = require('../lib/coverage-metrics');

const repoRoot = path.resolve(__dirname, '..');
const coverageFile = path.join(repoRoot, 'coverage', 'proxy', 'coverage-final.json');
const securityModules = new Set([
  'logger.js',
  'management-auth.js',
  'management-utils.js',
  'proxy-transport.js',
  'safe-routing-pattern.js',
  'validator.js',
]);
const thresholds = {
  statements: 79,
  branches: 70,
  functions: 82,
  lines: 79,
};

if (!fs.existsSync(coverageFile)) {
  throw new Error(`Coverage report is missing: ${coverageFile}`);
}
const coverage = JSON.parse(fs.readFileSync(coverageFile, 'utf8'));
const metrics = collectCoverageMetrics(coverage, (filePath) =>
  securityModules.has(path.basename(filePath))
);
const failures = [];
for (const [name, minimum] of Object.entries(thresholds)) {
  const actual = metrics[name].percentage;
  if (actual < minimum) failures.push(`${name} ${actual}% < ${minimum}%`);
}

if (failures.length > 0) {
  throw new Error(`Security boundary coverage failed: ${failures.join(', ')}`);
}
console.log(
  '[coverage-security] ok: ' +
    Object.entries(metrics)
      .map(([name, metric]) => `${name}=${metric.percentage}%`)
      .join(', ')
);
