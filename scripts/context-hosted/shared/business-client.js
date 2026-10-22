'use strict';

const http = require('node:http');
const { exact } = require('./boundary.js');
const fail = () => new Error('n08_business_request_rejected');

// Owner attestation is supplied by the original owned adapter. Templates are
// opaque capabilities made by the fixed scenario composer, never raw caller URLs.
function createBusinessClient(input, request = http.request) {
  const options = exact(input, ['entryPort', 'entryKey', 'templates']);
  if (
    !Number.isInteger(options.entryPort) ||
    options.entryPort < 1024 ||
    options.entryPort > 65535 ||
    typeof options.entryKey !== 'string' ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(options.entryKey) ||
    typeof request !== 'function'
  )
    throw fail();
  const templates = exact(options.templates, ['compact', 'continuation', 'ordinary']);
  const sealed = Object.create(null);
  for (const name of Object.keys(templates)) {
    if (
      !Buffer.isBuffer(templates[name]) ||
      templates[name].length < 2 ||
      templates[name].length > 262144
    )
      throw fail();
    const bytes = Buffer.from(templates[name]);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw fail();
    try {
      const parsed = JSON.parse(text);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw fail();
    } catch {
      throw fail();
    }
    sealed[name] = bytes;
  }
  return async (name) => {
    if (!Object.hasOwn(sealed, name)) throw fail();
    const body = sealed[name];
    return new Promise((resolve, reject) => {
      let settled = false;
      let outgoing;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        result ? resolve(result) : reject(fail());
      };
      const timer = setTimeout(() => {
        finish(null);
        outgoing?.destroy();
      }, 15000);
      try {
        outgoing = request(
          {
            host: '127.0.0.1',
            port: options.entryPort,
            method: 'POST',
            path: name === 'compact' ? '/v1/responses/compact' : '/v1/responses',
            agent: false,
            headers: {
              authorization: 'Bearer ' + options.entryKey,
              'content-type': 'application/json',
              'content-length': body.length,
            },
          },
          (response) => {
            const chunks = [];
            let bytes = 0;
            response.on('data', (chunk) => {
              bytes += chunk.length;
              if (bytes > 262144) {
                finish(null);
                outgoing.destroy();
              } else chunks.push(Buffer.from(chunk));
            });
            response.on('end', () => {
              const status = response.statusCode;
              if (
                !Number.isInteger(status) ||
                status < 100 ||
                status > 599 ||
                (status >= 300 && status <= 399)
              )
                finish(null);
              else finish(Object.freeze({ status, bytes: Buffer.concat(chunks) }));
            });
            response.on('error', () => finish(null));
            response.on('aborted', () => finish(null));
          }
        );
        outgoing.on('error', () => finish(null));
        outgoing.end(body);
      } catch {
        finish(null);
      }
    });
  };
}
module.exports = { createBusinessClient };
