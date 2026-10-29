'use strict';

const http = require('node:http');
const { isDeepStrictEqual } = require('node:util');
const fail = () => new Error('installed_http_drain_failed');

// Only fixed synthetic plans created by the acceptance owner enter this module.
// Partial SSE bytes must actually reach the entry client before stop is requested.
function startDrainResponse({ port, options, plan, isReleased, onPrefix, onFinished, onRequest }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        agent: false,
        method: 'POST',
        path: options.client === 'codex' ? '/v1/responses' : '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'content-length': plan.body.length,
          authorization: 'Bearer ' + options.entryToken,
        },
      },
      (incoming) => {
        const chunks = [];
        let size = 0,
          prefix = false;
        incoming.on('error', () => reject(fail()));
        incoming.on('aborted', () => reject(fail()));
        incoming.on('data', (chunk) => {
          size += chunk.length;
          if (size > 65536) {
            incoming.destroy();
            reject(fail());
            return;
          }
          chunks.push(chunk);
          if (plan.stream && !isReleased()) {
            const received = Buffer.concat(chunks);
            if (
              received.length > plan.split ||
              !received.equals(plan.reply.wire.subarray(0, received.length))
            ) {
              incoming.destroy();
              reject(fail());
              return;
            }
            if (received.length === plan.split && !prefix) {
              prefix = true;
              onPrefix();
            }
          }
        });
        incoming.once('end', () => {
          onFinished();
          try {
            const bytes = Buffer.concat(chunks);
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (
              !isReleased() ||
              incoming.statusCode !== 200 ||
              typeof incoming.headers['content-type'] !== 'string' ||
              incoming.headers['content-type'].split(';')[0].trim().toLowerCase() !==
                (plan.stream ? 'text/event-stream' : 'application/json')
            )
              throw fail();
            if (plan.stream) {
              if (!prefix || !bytes.equals(plan.reply.wire)) throw fail();
            } else if (!isDeepStrictEqual(JSON.parse(text), plan.expected)) throw fail();
            resolve(true);
          } catch {
            reject(fail());
          }
        });
      }
    );
    onRequest(request);
    request.on('error', () => reject(fail()));
    request.end(plan.body);
  });
}

module.exports = { startDrainResponse };
