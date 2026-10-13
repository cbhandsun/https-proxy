'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

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

module.exports = { FakeWbipcSocket };
