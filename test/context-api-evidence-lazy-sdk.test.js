'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const load = Module._load;
let sdkLoads = 0;
Module._load = function (id, ...args) {
  if (id.startsWith('@modelcontextprotocol/sdk/')) {
    sdkLoads++;
    throw new Error('SDK unavailable in startup fixture');
  }
  return load.call(this, id, ...args);
};

async function main() {
  try {
    const { createContextApiEvidenceHttp } = require('../lib/proxy/context-api-evidence-http');
    let failures = 0;
    let releases = 0;
    const capability = {
      acquireObservation: () => () => {
        releases++;
      },
      observationFailed: () => {
        failures++;
      },
    };
    const runtime = {
      bind: () => capability,
      create: () => ({ ok: true }),
    };
    const handler = createContextApiEvidenceHttp(runtime);
    function invoke(url, auth, enabled, body = '{}') {
      const request = new EventEmitter();
      request.method = 'POST';
      request.headers = {};
      request.destroy = () => {};
      const response = new EventEmitter();
      response.writeHead = (status) => {
        response.status = status;
        response.headersSent = true;
      };
      response.end = (text) => {
        response.body = JSON.parse(text);
      };
      const handled = handler.handle(request, response, url, auth, enabled);
      request.emit('data', Buffer.from(body));
      request.emit('end');
      return { handled, response };
    }
    const owner = { ok: true, enabled: true };
    assert.equal(invoke('/v1/responses', owner, true).handled, false);
    assert.equal(invoke('/v1/context-evidence/mcp', owner, false).response.status, 404);
    assert.equal(invoke('/v1/context-evidence/mcp', { ok: false }, true).response.status, 404);
    assert.equal(invoke('/v1/context-evidence/session', owner, true).response.status, 201);
    assert.equal(invoke('/v1/context-evidence/mcp', owner, true, '{').response.status, 400);
    assert.equal(sdkLoads, 0);
    const failed = invoke('/v1/context-evidence/mcp', owner, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sdkLoads, 1);
    assert.equal(failed.response.status, 500);
    assert.deepEqual(failed.response.body, { ok: false, error: 'evidence_transport_unavailable' });
    assert.equal(failures, 1);
    assert.equal(releases, 1);
  } finally {
    Module._load = load;
  }
}

main()
  .then(() => console.log('[context-api-evidence-lazy-sdk.test] ok'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
