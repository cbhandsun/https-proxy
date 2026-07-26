const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-management-diagnostics-'));
delete process.env.PROXY_DATA_DIR;
process.env.PROXY_CONFIG_DIR = tmpDir;
process.env.PROXY_RUNTIME_DIR = tmpDir;

const {
  clearTextFileIfExists,
  createManagementDiagnosticsHandlers,
  readBoundedFullLog,
  readTailText,
} = require('../lib/proxy/handlers/management-diagnostics');

function createJsonRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body == null ? '' : String(body);
    },
  };
  return res;
}

try {
  const missingFile = path.join(tmpDir, 'missing.log');
  assert.strictEqual(readTailText(missingFile), '暂无日志记录');

  const logFile = path.join(tmpDir, 'proxy.log');
  fs.writeFileSync(logFile, ['one', 'two', 'three', 'four'].join('\n'), 'utf8');
  assert.strictEqual(readTailText(logFile, 2, 1024), 'three\nfour');

  fs.writeFileSync(logFile, 'head\n' + 'x'.repeat(80 * 1024) + '\ntail', 'utf8');
  const bounded = readBoundedFullLog(logFile, 1);
  assert.ok(bounded.startsWith('[log truncated:'), 'full log reads should report truncation');
  assert.ok(bounded.endsWith('tail'), 'full log reads should preserve the tail');

  assert.strictEqual(clearTextFileIfExists(missingFile), false);
  assert.strictEqual(clearTextFileIfExists(logFile), true);
  assert.strictEqual(fs.readFileSync(logFile, 'utf8'), '');

  const eventsFile = path.join(tmpDir, 'proxy-events.jsonl');
  fs.writeFileSync(
    eventsFile,
    [
      JSON.stringify({ time: '2026-01-01T00:00:00.000Z', kind: 'request_start', path: '/old' }),
      'not json',
      JSON.stringify({
        time: '2026-01-01T00:00:02.000Z',
        kind: 'request_end',
        method: 'GET',
        path: '/new',
        statusCode: 500,
        elapsed: 12,
        type: 'local_management',
      }),
    ].join('\n') + '\n',
    'utf8'
  );

  const handlers = createManagementDiagnosticsHandlers({
    sendJson(res, statusCode, data) {
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    },
  });

  const eventsRes = createJsonRes();
  handlers.handleLocalEventsRequest(
    {
      url: '/v1/local/events?limit=5&after=2026-01-01T00:00:01.000Z',
      headers: { host: 'localhost' },
    },
    eventsRes
  );
  assert.strictEqual(eventsRes.statusCode, 200);
  assert.deepStrictEqual(
    JSON.parse(eventsRes.body).map((event) => event.path),
    ['/new']
  );

  const clearRes = createJsonRes();
  handlers.handleLocalEventsClearRequest({ url: '/v1/local/events/clear', headers: {} }, clearRes);
  assert.strictEqual(clearRes.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(clearRes.body), { ok: true });
  assert.strictEqual(fs.readFileSync(eventsFile, 'utf8'), '');

  fs.writeFileSync(
    eventsFile,
    JSON.stringify({
      time: '2026-01-01T00:00:03.000Z',
      kind: 'request_end',
      method: 'GET',
      path: '/v1/local/diagnostics',
      statusCode: 500,
      elapsed: 1,
      type: 'local_management',
    }) + '\n',
    'utf8'
  );
  const diagnosticsRes = createJsonRes();
  handlers.handleLocalDiagnosticsGetRequest(
    { url: '/v1/local/diagnostics', headers: { host: 'localhost' } },
    diagnosticsRes
  );
  assert.strictEqual(diagnosticsRes.statusCode, 200);
  const diagnosticsBody = JSON.parse(diagnosticsRes.body);
  assert.strictEqual(diagnosticsBody.ok, true);
  assert.ok(
    diagnosticsBody.output.includes('type: local_management'),
    'diagnostics output should show top-level request_end type'
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('[management-diagnostics.test] ok');
