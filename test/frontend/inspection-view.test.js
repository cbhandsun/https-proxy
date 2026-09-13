// Tests for the shared, dependency-free monitor/audit view helpers.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractStaticImports } = require('../../lib/governance/module-graph');

const modelPath = path.join(
  __dirname,
  '..',
  '..',
  'tauri-ui',
  'src',
  'app',
  'models',
  'inspection-view.js'
);

(async () => {
  assert.equal(fs.existsSync(modelPath), true, 'inspection-view model must exist');
  assert.deepEqual(
    extractStaticImports(fs.readFileSync(modelPath, 'utf8')).filter((specifier) =>
      specifier.startsWith('.')
    ),
    [],
    'inspection-view model must remain dependency-free'
  );

  const view = await import('../../tauri-ui/src/app/models/inspection-view.js');

  // ---- query / range normalization ----
  assert.equal(view.normalizeInspectionQuery('  LOAD  '), 'load');
  assert.equal(view.normalizeInspectionQuery(null), '');
  assert.equal(view.normalizeInspectionQuery({}), '');
  assert.equal(
    view.normalizeInspectionQuery('x'.repeat(500)).length,
    view.INSPECTION_QUERY_MAX_CHARS
  );
  assert.equal(view.normalizeInspectionRange('1h'), '1h');
  assert.equal(view.normalizeInspectionRange('bogus'), 'all');
  assert.equal(view.normalizeInspectionRange(null), 'all');
  assert.equal(view.normalizeMonitorStatus('slow'), 'slow');
  assert.equal(view.normalizeMonitorStatus('nope'), 'all');
  assert.equal(view.normalizeAuditStatus('error'), 'error');
  assert.equal(view.normalizeAuditStatus(123), 'all');

  // ---- range boundaries ----
  const now = Date.parse('2026-06-12T12:00:00.000Z');
  assert.equal(view.inspectionRangeStart('all', now), 0);
  assert.equal(view.inspectionRangeStart('15m', now), now - 15 * 60 * 1000);
  assert.equal(view.inspectionRangeStart('7d', now), now - 7 * 24 * 60 * 60 * 1000);
  assert.equal(view.inspectionRangeStart('1h', NaN), Date.now() - 60 * 60 * 1000);
  assert.equal(view.isWithinInspectionRange(null, 0), true, 'no window keeps records');
  assert.equal(
    view.isWithinInspectionRange('2026-06-12T11:59:00.000Z', now - 15 * 60 * 1000),
    true
  );
  assert.equal(
    view.isWithinInspectionRange('2026-06-12T11:00:00.000Z', now - 15 * 60 * 1000),
    false
  );
  assert.equal(
    view.isWithinInspectionRange('not-a-date', now),
    true,
    'unparsable timestamps stay visible instead of being silently dropped'
  );

  // ---- latency helpers ----
  assert.equal(view.formatElapsedMs(0), '0ms');
  assert.equal(view.formatElapsedMs(999), '999ms');
  assert.equal(view.formatElapsedMs(1500), '1.5s');
  assert.equal(view.formatElapsedMs(45000), '45s');
  assert.equal(view.formatElapsedMs(125000), '2m05s');
  assert.equal(view.formatElapsedMs('5000'), '5.0s');
  assert.equal(view.formatElapsedMs(null), '未知耗时');
  assert.equal(view.formatElapsedMs(-1), '未知耗时');
  assert.equal(view.formatElapsedMs('abc'), '未知耗时');
  assert.equal(view.classifyLatency(4999), 'normal');
  assert.equal(view.classifyLatency(5000), 'slow');
  assert.equal(view.classifyLatency(15000), 'very-slow');
  assert.equal(view.classifyLatency(undefined), 'unknown');
  assert.equal(view.latencyLabel(6000), '偏慢');
  assert.equal(view.latencyLabel(20000), '极慢');
  assert.equal(view.latencyLabel(10), '');

  // ---- monitor aggregation ----
  const monitorEvents = [
    {
      kind: 'request_start',
      time: '2026-06-12T11:59:50.000Z',
      reqId: 'r1',
      method: 'POST',
      path: '/v1/messages',
      clientIp: '127.0.0.1',
    },
    {
      kind: 'route',
      time: '2026-06-12T11:59:51.000Z',
      method: 'POST',
      path: '/v1/messages',
      sourceModel: 'gpt-5.4',
      targetModel: 'claude-sonnet-4-6',
      profileName: 'Default',
      protocol: 'openai',
    },
    {
      kind: 'request_end',
      time: '2026-06-12T11:59:57.000Z',
      reqId: 'r1',
      method: 'POST',
      path: '/v1/messages',
      elapsed: 7000,
      statusCode: 200,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    {
      kind: 'request_start',
      time: '2026-06-12T11:59:58.000Z',
      reqId: 'r2',
      method: 'POST',
      path: '/v1/responses',
    },
    {
      kind: 'upstream_error',
      time: '2026-06-12T11:59:59.000Z',
      reqId: 'r2',
      method: 'POST',
      path: '/v1/responses',
      code: '502',
      error: 'upstream <script>alert(1)</script>',
    },
  ];

  const groups = view.aggregateMonitorEvents(monitorEvents);
  assert.equal(groups.length, 2, 'events are grouped per request');
  const g1 = groups.find((group) => group.reqId === 'r1');
  assert.equal(g1.method, 'POST');
  assert.equal(g1.path, '/v1/messages');
  assert.equal(g1.routed, true);
  assert.equal(g1.sourceModel, 'gpt-5.4');
  assert.equal(g1.targetModel, 'claude-sonnet-4-6');
  assert.equal(g1.elapsed, 7000);
  assert.equal(g1.statusCode, 200);
  assert.equal(g1.level, 'success');
  assert.equal(g1.events.length, 3);
  assert.equal(view.monitorGroupStatusLabel(g1), '成功');
  assert.equal(view.classifyLatency(g1.elapsed), 'slow');

  const g2 = groups.find((group) => group.reqId === 'r2');
  assert.equal(g2.level, 'error');
  assert.equal(g2.hasErrorEvent, true);
  assert.ok(g2.error.includes('<script>'), 'raw error text is preserved for text-only rendering');
  assert.equal(view.monitorGroupStatusLabel(g2), '失败');

  assert.deepEqual(view.aggregateMonitorEvents(null), []);
  assert.deepEqual(view.aggregateMonitorEvents([null, 5, 'x']), []);
  const anonymous = view.aggregateMonitorEvents([
    { kind: 'route', sourceModel: 'a', targetModel: 'b' },
    { kind: 'route', sourceModel: 'c', targetModel: 'd' },
  ]);
  assert.equal(
    anonymous.length,
    1,
    'reqId-less route events attach to the still-open request instead of duplicating cards'
  );
  assert.equal(anonymous[0].events.length, 2);
  const closedThenOrphan = view.aggregateMonitorEvents([
    {
      kind: 'request_end',
      reqId: 'closed',
      statusCode: 200,
      elapsed: 5,
      time: '2026-06-12T00:00:00.000Z',
    },
    { kind: 'route', sourceModel: 'orphan', targetModel: 'x' },
  ]);
  assert.equal(
    closedThenOrphan.length,
    2,
    'an orphaned route after a closed request is its own card'
  );

  // ---- monitor filtering ----
  assert.equal(view.filterMonitorGroups(groups, { range: '1h', now, status: 'all' }).length, 2);
  assert.equal(view.filterMonitorGroups(groups, { range: '1h', now, status: 'success' }).length, 1);
  assert.equal(
    view.filterMonitorGroups(groups, { range: '1h', now, status: 'error' })[0].reqId,
    'r2'
  );
  assert.equal(
    view.filterMonitorGroups(groups, { range: '1h', now, status: 'route' }).length,
    1,
    'route filter matches requests that produced a route event'
  );
  assert.equal(
    view.filterMonitorGroups(groups, { range: '1h', now, status: 'route' })[0].reqId,
    'r1'
  );
  assert.equal(
    view.filterMonitorGroups(groups, { range: '1h', now, status: 'slow' }).length,
    1,
    'slow filter matches only slow requests'
  );
  assert.equal(
    view.filterMonitorGroups(groups, { range: 'all', status: 'all', query: 'CLAUDE-SONNET' })
      .length,
    1,
    'search is case-insensitive across target models'
  );
  assert.equal(
    view.filterMonitorGroups(groups, { range: 'all', status: 'all', query: 'no-such-thing' })
      .length,
    0
  );
  assert.equal(
    view.filterMonitorGroups(
      [{ kind: 'route', endTime: '2026-06-01T00:00:00.000Z', routed: true, events: [] }],
      { range: '24h', now }
    ).length,
    0,
    'old records are excluded by the time window'
  );
  assert.equal(
    view.filterMonitorGroups(groups, { range: '15m', now: NaN }).length >= 0,
    true,
    'NaN now falls back to the current clock without throwing'
  );

  const searchText = view.monitorGroupSearchText(g1);
  assert.ok(searchText.includes('gpt-5.4'));
  assert.ok(searchText.includes('claude-sonnet-4-6'));
  assert.equal(view.monitorGroupSearchText(null), '');
  assert.equal(view.monitorGroupStatusLabel(null), '未知');

  // ---- audit filtering ----
  const auditRecords = [
    {
      id: 'a1',
      time: '2026-06-12T11:59:00.000Z',
      method: 'POST',
      path: '/v1/messages',
      protocol: 'claude',
      profileName: 'Default',
      originalModel: 'claude-opus-4',
      statusCode: 200,
      elapsed: 120,
      system: 'you are helpful',
      messages: [{ role: 'user', content: 'hello world' }],
    },
    {
      id: 'a2',
      time: '2026-06-12T11:58:00.000Z',
      method: 'POST',
      path: '/v1/responses',
      protocol: 'openai',
      originalModel: 'gpt-5.4',
      statusCode: 500,
      elapsed: 22000,
      request: { body: '{"model":"gpt-5.4"}', truncated: false },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'secret prompt' }] }],
    },
    {
      id: 'a3',
      time: '2026-06-12T11:57:00.000Z',
      method: 'POST',
      path: '/v1/messages',
      statusCode: 200,
      elapsed: 6000,
      request: { body: '', truncated: false },
    },
  ];

  assert.equal(view.filterAuditRecords(auditRecords, { range: 'all', status: 'all' }).length, 3);
  assert.equal(
    view.filterAuditRecords(auditRecords, { range: 'all', status: 'success' }).length,
    2
  );
  assert.equal(
    view.filterAuditRecords(auditRecords, { range: 'all', status: 'error' })[0].id,
    'a2'
  );
  assert.equal(
    view.filterAuditRecords(auditRecords, { range: 'all', status: 'slow' }).length,
    2,
    'slow audit filter keeps requests at or above the slow threshold'
  );
  assert.equal(
    view.filterAuditRecords(
      [{ id: 'unknown-elapsed', time: '2026-06-12T00:00:00.000Z', statusCode: 200 }],
      { range: 'all', status: 'slow' }
    ).length,
    0,
    'unknown latency is not reported as slow'
  );
  assert.equal(
    view.filterAuditRecords(auditRecords, { range: 'all', status: 'all', query: 'HELLO' })[0].id,
    'a1',
    'audit search covers message content case-insensitively'
  );
  assert.equal(
    view.filterAuditRecords(auditRecords, { range: 'all', status: 'all', query: 'secret' })[0].id,
    'a2',
    'audit search covers structured content blocks'
  );
  const longRecord = {
    id: 'a4',
    time: '2026-06-12T11:59:00.000Z',
    messages: [{ role: 'user', content: 'x'.repeat(200000) }],
  };
  const longSearch = view.auditRecordSearchText(longRecord);
  assert.ok(longSearch.length < 20000, 'audit search text stays bounded for huge payloads');
  assert.deepEqual(view.filterAuditRecords(null), []);
  assert.deepEqual(view.filterAuditRecords([null, 1, 'x']), []);

  // ---- retry availability ----
  assert.deepEqual(view.auditRetryAvailability(null), {
    available: false,
    reason: '记录无效，无法重试',
  });
  assert.equal(view.auditRetryAvailability({ id: 'a1' }).available, false);
  assert.equal(
    view.auditRetryAvailability({ id: 'a1', request: { body: '', truncated: false } }).available,
    false,
    'missing request body disables retry'
  );
  assert.equal(
    view.auditRetryAvailability({ id: 'a1', request: { body: '{}', truncated: true } }).available,
    false,
    'truncated request body disables retry'
  );
  assert.deepEqual(
    view.auditRetryAvailability({ id: 'a1', request: { body: '{}', truncated: false } }),
    { available: true, reason: '' }
  );

  // ---- paging ----
  assert.equal(view.pageSize(undefined, 30, 500), 30);
  assert.equal(view.pageSize('60', 30, 500), 60);
  assert.equal(view.pageSize(-5, 30, 500), 30);
  assert.equal(view.pageSize(9999, 30, 500), 500);
  assert.deepEqual(view.newestWindow([1, 2, 3, 4, 5], 2), [4, 5]);
  assert.deepEqual(view.newestWindow([1, 2, 3], 99), [1, 2, 3]);
  assert.deepEqual(view.newestWindow(null, 2), []);

  // ---- CSV safety ----
  assert.equal(view.buildCsv([], []), '');
  assert.equal(view.buildCsv(null, null), '');
  assert.equal(view.buildCsv([{ id: 'a', label: 'a' }], [{ a: 'plain' }]), 'a\r\nplain');
  assert.equal(
    view.buildCsv([{ id: 'a', label: 'a' }], [{ a: 'with,comma' }]),
    'a\r\n"with,comma"'
  );
  assert.equal(view.buildCsv([{ id: 'a', label: 'a' }], [{ a: 'say "hi"' }]), 'a\r\n"say ""hi"""');
  assert.equal(
    view.buildCsv([{ id: 'a', label: 'a' }], [{ a: '=cmd|calc' }]),
    "a\r\n'=cmd|calc",
    'spreadsheet formulas are neutralised'
  );
  assert.equal(
    view.buildCsv([{ id: 'a', label: 'a' }], [{ a: '+1+1' }]),
    "a\r\n'+1+1",
    'leading plus is neutralised'
  );
  assert.equal(
    view.buildCsv([{ id: 'a', label: 'a' }], [{ a: '@SUM(1)' }]),
    "a\r\n'@SUM(1)",
    'leading at-sign is neutralised'
  );
  assert.ok(
    view.buildCsv([{ id: 'a', label: 'a' }], [{ a: 'line\nbreak' }]).includes('"line\nbreak"'),
    'embedded newlines are quoted'
  );

  const csv = view.buildAuditExportCsv([
    {
      time: '2026-06-12T00:00:00.000Z',
      method: 'POST',
      path: '/v1/messages',
      protocol: 'claude',
      profileName: 'Default',
      originalModel: 'claude-opus-4',
      statusCode: 200,
      elapsed: 120,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      cost: { amount: 0.01 },
    },
  ]);
  assert.ok(csv.startsWith('time,method,path,protocol'));
  assert.ok(csv.includes('claude-opus-4'));
  assert.ok(csv.includes('0.01'));
  assert.equal(csv.split('\r\n').length, 2);
  const rows = view.buildAuditExportRows(null);
  assert.deepEqual(rows, []);

  // ---- export payload + file naming ----
  const payload = view.buildMonitorExportPayload(groups, {
    range: '1h',
    status: 'slow',
    query: 'gpt',
  });
  assert.equal(payload.source, 'https-proxy-manager/monitor');
  assert.equal(payload.requestCount, 2);
  assert.equal(payload.filters.range, '1h');
  assert.equal(payload.filters.status, 'slow');
  assert.equal(payload.requests[0].latency, 'slow');
  assert.equal(view.buildMonitorExportPayload(null).requestCount, 0);

  assert.equal(view.sanitizeExportFileName('audit-2026/06/12.json'), 'audit-2026-06-12.json');
  assert.equal(view.sanitizeExportFileName('../../etc/passwd'), 'etc-passwd');
  assert.equal(view.sanitizeExportFileName(''), 'hpm-export');
  assert.equal(view.sanitizeExportFileName(null), 'hpm-export');
  assert.equal(view.sanitizeExportFileName('...'), 'hpm-export');
  assert.equal(view.sanitizeExportFileName('x'.repeat(400)).length <= 80, true);
  assert.match(
    view.exportTimestamp(new Date('2026-06-12T00:00:00.000Z')),
    /^2026-06-12T00-00-00-000Z$/
  );
  assert.match(view.exportTimestamp(new Date('invalid')), /^\d{4}-\d{2}-\d{2}T/);

  console.log('inspection-view.test.js ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
