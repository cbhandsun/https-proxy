'use strict';

const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const { recoveryHistoryRequestLimit } = require('./context-recovery-history-request');
const { createContextForwardHeaders } = require('./context-transport-policy');
const { createSseJsonDecoder } = require('./forced-stream-collector');
const { isRecoveryHttpCacheMiss } = require('./context-recovery-cache-miss');

function createContextRecoveryHttpDispatch(
  transport,
  requestOptions,
  authorized,
  { kind, historyFormat = 2 } = {}
) {
  const requestBytes = recoveryHistoryRequestLimit(historyFormat);
  if (typeof transport?.request !== 'function' || typeof authorized !== 'function')
    throw new TypeError('Invalid recovery HTTP capability');
  // Snapshot the composition root's route and credentials before any async work.
  const pinned = {
    ...requestOptions,
    headers: createContextForwardHeaders(requestOptions.headers),
  };
  return (body, { signal }) =>
    new Promise((resolve, reject) => {
      let request;
      let response;
      let settled = false;
      function permitted() {
        try {
          return authorized() === true;
        } catch {
          return false;
        }
      }
      function done(error, value) {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        if (error) {
          request?.destroy();
          response?.destroy();
          reject(new Error('Recovery HTTP dispatch failed'));
        } else resolve(value);
      }
      const abort = () => done(true);
      try {
        if (signal.aborted || !permitted()) {
          done(true);
          return;
        }
        const wire = Buffer.from(JSON.stringify(body));
        if (wire.length > requestBytes) {
          done(true);
          return;
        }
        const headers = createContextForwardHeaders(pinned.headers);
        for (const key of Object.keys(headers)) {
          if (
            ['content-encoding', 'transfer-encoding', 'content-length', 'accept-encoding'].includes(
              key.toLowerCase()
            )
          )
            delete headers[key];
        }
        headers['content-length'] = String(wire.length);
        headers['accept-encoding'] = 'identity';
        request = transport.request({ ...pinned, headers }, (incoming) => {
          response = incoming;
          // Consume transport errors even if validation rejects the response early.
          incoming.once('error', () => done(true));
          incoming.once('aborted', () => done(true));
          incoming.once('close', () => {
            if (!settled) done(true);
          });
          if (settled) {
            incoming.destroy();
            return;
          }
          if (
            !permitted() ||
            (incoming.statusCode !== 200 &&
              !(
                kind === 'responses' &&
                incoming.statusCode === 400 &&
                typeof incoming.headers['content-type'] === 'string' &&
                /^application\/json(?:\s*;|$)/i.test(incoming.headers['content-type'])
              )) ||
            ![undefined, 'identity'].includes(incoming.headers['content-encoding'])
          ) {
            done(true);
            return;
          }
          const chunks = [];
          let size = 0;
          let terminal = false;
          let terminalDecoder;
          incoming.on('data', (chunk) => {
            if (settled) return;
            if (!Buffer.isBuffer(chunk)) {
              done(true);
              return;
            }
            size += chunk.length;
            if (size > MAX_WIRE_BYTES) {
              done(true);
              return;
            }
            chunks.push(Buffer.from(chunk));
            if (terminalDecoder === undefined) {
              const type = incoming.headers['content-type'] ?? '';
              if (typeof type !== 'string') {
                done(true);
                return;
              }
              terminalDecoder =
                kind === 'responses' && (type.includes('text/event-stream') || !type)
                  ? createSseJsonDecoder(MAX_WIRE_BYTES, (event) => {
                      if (event.type === 'response.completed') terminal = true;
                      if (['response.failed', 'response.incomplete', 'error'].includes(event.type))
                        throw new Error('Recovery upstream terminal failure');
                    })
                  : null;
            }
            if (terminalDecoder) {
              try {
                terminalDecoder.push(chunk);
                if (terminal) {
                  if (!permitted()) {
                    done(true);
                    return;
                  }
                  // A complete SSE block ends this internal request even when
                  // the backend keeps HTTP open. The runner still validates the
                  // complete response envelope before any state is committed.
                  done(false, { statusCode: 200, wire: Buffer.concat(chunks), stream: true });
                  incoming.destroy();
                  request?.destroy();
                }
              } catch {
                done(true);
              }
            }
          });
          incoming.once('end', () => {
            if (settled) return;
            if (!incoming.complete || !permitted()) {
              done(true);
              return;
            }
            const output = Buffer.concat(chunks);
            const type = incoming.headers['content-type'] ?? '';
            if (typeof type !== 'string') {
              done(true);
              return;
            }
            const stream =
              type.includes('text/event-stream') ||
              (!type && /^(?:event:|data:)/.test(output.toString('utf8').trimStart()));
            if (incoming.statusCode === 400) {
              const failure = { statusCode: 400, wire: output, stream };
              if (!isRecoveryHttpCacheMiss(body, failure)) done(true);
              else done(false, failure);
              return;
            }
            done(false, { statusCode: 200, wire: output, stream });
          });
        });
        request.once('error', () => done(true));
        request.once('timeout', () => done(true));
        request.once('close', () => {
          if (!response && !settled) done(true);
        });
        if (settled) {
          request.destroy();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        request.end(wire);
      } catch {
        done(true);
      }
    });
}

module.exports = { createContextRecoveryHttpDispatch };
