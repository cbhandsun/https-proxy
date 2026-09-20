'use strict';

const assert = require('node:assert/strict');

(async () => {
  const format = await import('../../tauri-ui/src/app/runtime/audit-format.js');
  const marker = 'private-marker';
  const record = {
    contextDiagnostics: {
      contextBudget: {
        policy: 'overflow-drop-oldest',
        source: 'responses',
        inputBudgetTokens: 1000,
        estimatedBeforeTokens: 1400,
        estimatedInputTokens: 900,
        optimizedCount: 2,
        droppedCount: 1,
        overBudgetTokens: 400,
        contextCache: {
          candidate: true,
          stablePrefixHash: 'hash-only',
          stablePrefixTokens: 500,
          dynamicTokens: 400,
        },
      },
      providerCache: {
        provider: 'gemini',
        policy: 'diagnostics-only',
        candidate: true,
      },
      prompt: marker,
    },
  };

  const summary = format.auditContextHealthSummary(record);
  assert.equal(summary.severity, 'danger');
  assert.ok(summary.title.includes('丢弃'));
  assert.ok(summary.badges.includes('drop:1'));
  assert.equal(JSON.stringify(summary).includes(marker), false);

  const rows = format.auditContextDiagnosticRows(record);
  assert.ok(rows.some(([label, value]) => label === '前缀 Hash' && value === 'hash-only'));
  assert.equal(JSON.stringify(rows).includes(marker), false);

  const missing = format.auditContextHealthSummary({});
  assert.equal(missing.state, 'missing');
  assert.ok(missing.badges.includes('no-context-diagnostics'));

  console.log('audit-format.test.js ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
