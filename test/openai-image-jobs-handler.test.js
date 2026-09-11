'use strict';

const assert = require('assert');
const { createOpenAIImageJobHandlers } = require('../lib/proxy/handlers/openai-image-jobs');

const stored = new Map();
let createdInput;
const imageJobStore = {
  create(input) {
    createdInput = input;
    const job = {
      id: 'imgjob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      object: 'image.job',
      status: 'queued',
      created_at: 1,
      updated_at: 1,
      expires_at: 3601,
    };
    stored.set(job.id, { ...job, owner: input.owner });
    return job;
  },
  get(id, owner) {
    const job = stored.get(id);
    return job && job.owner === owner ? { ...job, owner: undefined } : null;
  },
  cancel(id, owner) {
    const job = this.get(id, owner);
    return job ? { ...job, status: 'cancelled' } : null;
  },
};
const requestEnds = [];
const responses = [];
const handlers = createOpenAIImageJobHandlers({
  executeImageJob: async () => ({ created: 2, data: [{ b64_json: 'image' }] }),
  imageJobStore,
  logProxyEvent() {},
  logRequestEnd(...args) {
    requestEnds.push(args);
  },
  parseProxyBody(_response, buffer) {
    return JSON.parse(buffer.toString('utf8'));
  },
  writeJsonResponse(response, status, body, headers) {
    response.status = status;
    response.body = body;
    response.headers = headers || {};
    responses.push(response);
  },
});

const createRequest = {
  method: 'POST',
  url: '/v1/image-jobs',
  entryAuth: { enabled: true, key: { id: 'client-a' } },
};
const createResponse = {};
handlers.handleOpenAIImageJobCreate(
  createRequest,
  createResponse,
  {
    buffer: Buffer.from(
      JSON.stringify({
        model: 'gemini-3.1-flash-image',
        prompt: 'draw a circle',
        response_format: 'b64_json',
      })
    ),
    model: 'gemini-3.1-flash-image',
    rewriteTo: 'gemini-3.1-flash-image',
    profile: { id: 'google-official', protocol: 'gemini' },
  },
  { protocol: 'https:', hostname: 'example.test', port: 443, path: '' },
  'managed-token',
  '/image-jobs',
  1000
);
assert.strictEqual(createResponse.status, 202);
assert.strictEqual(createResponse.headers.Location, createResponse.body.status_url);
assert.strictEqual(createResponse.headers['Retry-After'], '2');
assert.strictEqual(createdInput.owner, 'entry-key:client-a');
assert.strictEqual(typeof createdInput.run, 'function');
assert.strictEqual(requestEnds.at(-1)[3], 202);

const statusResponse = {};
handlers.handleOpenAIImageJobControl(
  { method: 'GET', url: createResponse.body.status_url, entryAuth: createRequest.entryAuth },
  statusResponse,
  createResponse.body.id,
  1001
);
assert.strictEqual(statusResponse.status, 200);
assert.strictEqual(statusResponse.body.status, 'queued');
assert.strictEqual(statusResponse.headers['Retry-After'], '2');

const hiddenResponse = {};
handlers.handleOpenAIImageJobControl(
  {
    method: 'GET',
    url: createResponse.body.status_url,
    entryAuth: { enabled: true, key: { id: 'client-b' } },
  },
  hiddenResponse,
  createResponse.body.id,
  1002
);
assert.strictEqual(hiddenResponse.status, 404);

const cancelResponse = {};
handlers.handleOpenAIImageJobControl(
  { method: 'DELETE', url: createResponse.body.status_url, entryAuth: createRequest.entryAuth },
  cancelResponse,
  createResponse.body.id,
  1003
);
assert.strictEqual(cancelResponse.status, 200);
assert.strictEqual(cancelResponse.body.status, 'cancelled');

const invalidResponse = {};
handlers.handleOpenAIImageJobCreate(
  createRequest,
  invalidResponse,
  {
    buffer: Buffer.from(JSON.stringify({ model: 'gemini-3.1-flash-image', prompt: '', n: 2 })),
    model: 'gemini-3.1-flash-image',
    rewriteTo: 'gemini-3.1-flash-image',
    profile: { id: 'google-official', protocol: 'gemini' },
  },
  {},
  '',
  '/image-jobs',
  1004
);
assert.strictEqual(invalidResponse.status, 400);

console.log('[openai-image-jobs-handler.test] ok');
