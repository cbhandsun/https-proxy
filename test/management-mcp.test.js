const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-management-mcp-'));
process.env.PROXY_DATA_DIR = tmpDir;

const { createManagementMcpHandlers } = require('../lib/proxy/handlers/management-mcp');

function jsonReq(url, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  req.url = url;
  req.headers = { host: 'localhost' };
  return req;
}

function emptyReq(url) {
  const req = Readable.from([]);
  req.url = url;
  req.headers = { host: 'localhost' };
  return req;
}

function createRes() {
  return {
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
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function waitForEnd(req, invoke) {
  return new Promise((resolve) => {
    const res = createRes();
    const originalEnd = res.end.bind(res);
    res.end = (body) => {
      originalEnd(body);
      resolve(res);
    };
    invoke(req, res);
  });
}

(async () => {
  const initialConfig = {
    mcpHub: {
      servers: [{ id: 'old', url: 'http://127.0.0.1:3001/mcp' }],
      routing: [],
    },
  };
  let savedConfig = null;
  const handlers = createManagementMcpHandlers({
    sendJson,
    currentConfigSnapshot: () => initialConfig,
    readRawConfigSnapshot: () => JSON.parse(JSON.stringify(initialConfig)),
    writeRawConfigSnapshot: (nextConfig) => {
      savedConfig = nextConfig;
    },
  });

  const getRes = createRes();
  handlers.handleLocalMcpHubGetRequest(emptyReq('/v1/local/mcp-hub'), getRes);
  assert.strictEqual(getRes.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(getRes.body).mcpHub.servers[0].id, 'old');

  const invalidShape = await waitForEnd(
    jsonReq('/v1/local/mcp-hub', { mcpHub: { servers: {}, routing: [] } }),
    handlers.handleLocalMcpHubSaveRequest
  );
  assert.strictEqual(invalidShape.statusCode, 400);
  assert.match(JSON.parse(invalidShape.body).error, /required arrays/);
  assert.strictEqual(savedConfig, null, 'invalid shape must not write config');

  const invalidUrl = await waitForEnd(
    jsonReq('/v1/local/mcp-hub', {
      mcpHub: {
        servers: [{ id: 'bad', url: 'file:///tmp/socket' }],
        routing: [],
      },
    }),
    handlers.handleLocalMcpHubSaveRequest
  );
  assert.strictEqual(invalidUrl.statusCode, 400);
  assert.match(JSON.parse(invalidUrl.body).error, /must be http/);
  assert.strictEqual(savedConfig, null, 'invalid server URL must not write config');

  const valid = await waitForEnd(
    jsonReq('/v1/local/mcp-hub', {
      mcpHub: {
        servers: [{ id: 'ok', url: 'http://127.0.0.1:3002/mcp' }],
        routing: [{ toolName: 'search', serverId: 'ok' }],
      },
    }),
    handlers.handleLocalMcpHubSaveRequest
  );
  assert.strictEqual(valid.statusCode, 200);
  assert.deepStrictEqual(savedConfig.mcpHub.routing, [{ toolName: 'search', serverId: 'ok' }]);

  fs.writeFileSync(
    path.join(tmpDir, 'mcp-execution.jsonl'),
    ['first', 'second', 'third'].join('\n'),
    'utf8'
  );
  const logsRes = createRes();
  handlers.handleLocalMcpHubLogsRequest(emptyReq('/v1/local/mcp-hub/logs?lines=2'), logsRes);
  assert.strictEqual(logsRes.statusCode, 200);
  assert.strictEqual(JSON.parse(logsRes.body).logs, 'second\nthird');

  console.log('[management-mcp.test] ok');
})()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
