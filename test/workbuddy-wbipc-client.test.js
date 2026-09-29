'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { createWorkBuddyWbipcClient } = require('../lib/proxy/workbuddy-wbipc-client');

function ticketId(ticket) {
  return crypto.createHash('sha256').update(ticket, 'utf8').digest('hex').slice(0, 16);
}

function encodeTranscript(role, transcript) {
  const parts = [
    role === 'server' ? 'wbipc-s' : 'wbipc-c',
    String(transcript.protocol),
    transcript.endpoint,
    transcript.clientNonce,
    transcript.serverNonce,
  ];
  const chunks = [];
  for (const part of parts) {
    const value = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length, 0);
    chunks.push(length, value);
  }
  return Buffer.concat(chunks);
}

function proof(ticket, role, transcript) {
  return crypto
    .createHmac('sha256', Buffer.from(ticket, 'utf8'))
    .update(encodeTranscript(role, transcript))
    .digest('base64url');
}

class FakeWbipcSocket extends EventEmitter {
  constructor(ticket, endpoint, onFetch) {
    super();
    this.ticket = ticket;
    this.endpoint = endpoint;
    this.onFetch = onFetch;
    this.buffer = '';
    this.clientNonce = '';
    this.serverNonce = 'server-nonce-for-test';
    this.destroyed = false;
    process.nextTick(() => this.emit('connect'));
  }

  write(chunk) {
    this.buffer += String(chunk);
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) return true;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      this.handleFrame(JSON.parse(line));
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }

  send(frame) {
    process.nextTick(() => this.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`)));
  }

  handleFrame(frame) {
    if (frame.type === 'session_hello') {
      assert.strictEqual(frame.ticket_id, ticketId(this.ticket));
      this.clientNonce = frame.client_nonce;
      const transcript = {
        protocol: 1,
        endpoint: this.endpoint,
        clientNonce: this.clientNonce,
        serverNonce: this.serverNonce,
      };
      this.send({
        type: 'session_challenge',
        protocol: 1,
        server_nonce: this.serverNonce,
        server_proof: proof(this.ticket, 'server', transcript),
      });
      return;
    }
    if (frame.type === 'session_prove') {
      const transcript = {
        protocol: 1,
        endpoint: this.endpoint,
        clientNonce: this.clientNonce,
        serverNonce: this.serverNonce,
      };
      assert.strictEqual(frame.client_proof, proof(this.ticket, 'client', transcript));
      this.send({
        type: 'session_hello_ack',
        protocol: 1,
        connection_epoch: 'ce-test',
        max_inflight: 8,
        pipes: ['wb.request'],
      });
      return;
    }
    if (frame.method === 'broker/GetPipe') {
      this.send({
        jsonrpc: '2.0',
        id: frame.id,
        result: { channel: 'c:wb.request', methods: ['http.fetch'] },
      });
      return;
    }
    if (frame.method === 'c:wb.request/http.fetch') {
      this.onFetch(frame.params);
      this.send({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body_b64: Buffer.from(JSON.stringify({ ok: true })).toString('base64'),
        },
      });
    }
  }
}

async function main() {
  const ticket = 'test-ticket-value-that-is-not-a-secret';
  const endpoint = '\\\\.\\pipe\\wbipc-test';
  let fetchParams = null;
  const client = createWorkBuddyWbipcClient({
    readEndpoint() {
      return { endpoint, ticket };
    },
    connect(target) {
      assert.strictEqual(target, endpoint);
      return new FakeWbipcSocket(ticket, endpoint, (params) => {
        fetchParams = params;
      });
    },
    timeoutMs: 1000,
  });

  const result = await client.request({
    method: 'POST',
    path: '/v2/chat/completions',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: Buffer.from('{"model":"demo"}'),
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(JSON.parse(result.body), { ok: true });
  assert.strictEqual(fetchParams.method, 'POST');
  assert.strictEqual(fetchParams.path, '/v2/chat/completions');
  assert.strictEqual(fetchParams.headers.authorization, undefined);
  assert.strictEqual(fetchParams.body_b64, Buffer.from('{"model":"demo"}').toString('base64'));

  const unavailable = await createWorkBuddyWbipcClient({
    readEndpoint() {
      return null;
    },
  }).request({ method: 'POST', path: '/v2/chat/completions', body: '{}' });
  assert.deepStrictEqual(unavailable, { ok: false, status: 'not_available' });

  console.log('[workbuddy-wbipc-client.test] ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
