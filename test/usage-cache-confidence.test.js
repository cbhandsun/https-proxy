'use strict';
const assert = require('node:assert/strict');
const { buildUsageReport } = require('../lib/proxy/usage-report');
const provider = {
  inputTokens: 1000,
  cachedInputTokens: 800,
  outputTokens: 120,
  totalTokens: 1120,
  source: 'provider',
};
const record = (usage, model = 'test') => ({ statusCode: 200, originalModel: model, usage });
const estimated = { ...provider, inputTokens: 100000, cachedInputTokens: 0, source: 'estimated' };
let report = buildUsageReport([record(provider), record(estimated)], {});
assert.equal(
  report.total.cacheHitRate,
  0.8,
  'estimated prompts must not dilute measured cache rate'
);
assert.equal(report.total.providerInputTokens, 1000);
assert.equal(report.total.estimatedRecords, 1);
assert.equal(report.total.context.providerCacheConfirmedHits, 1);
report = buildUsageReport([record(estimated, 'tianxi/super')], {});
assert.equal(report.total.cacheHitRate, null);
assert.equal(report.byModel[0].cacheHitRate, null);
assert.equal(report.recent[0].usage.cacheHitRate, null);
assert.equal(buildUsageReport([], {}).total.cacheHitRate, null);
assert.equal(
  JSON.stringify(
    buildUsageReport([record({ ...provider, source: 'private-marker' })], {})
  ).includes('private-marker'),
  false
);
assert.equal(
  buildUsageReport([record({ ...provider, cachedInputTokens: 0 })], {}).total.cacheHitRate,
  0
);
assert.equal(
  buildUsageReport([record({ ...provider, inputTokens: 0 })], {}).total.cacheHitRate,
  null
);
assert.equal(
  buildUsageReport([record({ ...provider, cachedInputTokens: 1e20 })], {}).total.cacheHitRate,
  1
);
assert.equal(
  buildUsageReport([record({ ...provider, inputTokens: -1, cachedInputTokens: -1 })], {}).total
    .cacheHitRate,
  null
);

report = buildUsageReport(
  [
    {
      ...record(provider, 'cache-model'),
      contextDiagnostics: {
        contextBudget: { contextCache: { stablePrefixHash: 'first' } },
        providerContext: { provider: 'anthropic', applied: true, explicit: false },
      },
    },
    {
      ...record({ ...provider, cachedInputTokens: 0 }, 'cache-model'),
      contextDiagnostics: {
        contextBudget: { contextCache: { stablePrefixHash: 'second' } },
        providerContext: { provider: 'anthropic', applied: false, explicit: true },
      },
    },
  ],
  {}
);
assert.equal(report.byModel[0].context.stablePrefixChanges, 1);
assert.equal(report.byModel[0].context.providerContextRecords, 2);
assert.equal(report.byModel[0].context.providerCompactionApplied, 1);
assert.equal(report.byModel[0].context.providerContextExplicit, 1);
assert.equal(Object.keys(report.byModel[0].context).includes('_lastStablePrefixHash'), false);
console.log('[usage-cache-confidence.test] ok');
