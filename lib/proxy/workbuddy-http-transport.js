'use strict';

const { Readable, Writable } = require('node:stream');
const { isWorkBuddyTarget } = require('./workbuddy-request-contract');

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function failure(status, code) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      error: { type: 'api_error', code, message: 'WorkBuddy host request failed' },
    }),
  };
}

function createWorkBuddyHttpTransport(prepared, apiKey, options = {}) {
  if (!isWorkBuddyTarget(prepared) || apiKey || !prepared.workbuddyAuth?.accessTokenEncrypted)
    return null;
  // Ordinary Chat requests must not initialize the optional desktop host stack.
  // Node caches successful imports; initialization errors retain their original failure path.
  const { createWorkBuddyWbipcClient } = require('./workbuddy-wbipc-client');
  const { isWorkBuddyHostUnavailable } = require('./workbuddy-host-recovery');
  const { planWorkBuddyWbipcRequest } = require('./workbuddy-context-planner');
  const { isWorkBuddyWbipcPayloadTooLarge } = require('./workbuddy-wbipc-payload');
  const { normalizeWorkBuddyChatSse } = require('./workbuddy-chat-stream-contract');
  const client = options.client || createWorkBuddyWbipcClient(options);
  return {
    request(requestOptions, onResponse) {
      const controller = new globalThis.AbortController();
      const chunks = [];
      let bytes = 0;
      let tooLarge = false;
      let timer;
      let response;
      let finished = false;
      const req = new Writable({
        autoDestroy: false,
        write(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > MAX_REQUEST_BYTES) {
            tooLarge = true;
            chunks.length = 0;
          } else if (!tooLarge) chunks.push(chunk);
          callback();
        },
        final(callback) {
          callback();
          Promise.resolve()
            .then(run)
            .catch(() => {
              if (finished) req.destroy(new Error('WorkBuddy response handling failed'));
              else deliver(failure(502, 'workbuddy_host_request_failed'));
            });
        },
        destroy(error, callback) {
          clearTimeout(timer);
          chunks.length = 0;
          controller.abort();
          if (response) response.destroy();
          callback(error);
        },
      });
      req.setTimeout = (milliseconds, callback) => {
        clearTimeout(timer);
        if (callback) req.once('timeout', callback);
        if (Number.isSafeInteger(milliseconds) && milliseconds > 0) {
          timer = setTimeout(() => {
            controller.abort();
            req.emit('timeout');
            deliver(failure(504, 'workbuddy_host_timeout'));
          }, milliseconds);
          timer.unref?.();
        }
        return req;
      };
      req.setTimeout(requestOptions.timeout);

      function deliver(result) {
        if (finished || req.destroyed) return;
        finished = true;
        clearTimeout(timer);
        const body = Buffer.from(result.body);
        const headers = {
          'content-type': 'application/json',
          'content-length': String(body.length),
        };
        const contentType = result.headers?.['content-type'];
        if (
          typeof contentType === 'string' &&
          contentType.length <= 256 &&
          !/[\r\n]/.test(contentType)
        )
          headers['content-type'] = contentType;
        const retryAfter = result.headers?.['retry-after'];
        if (typeof retryAfter === 'string' && /^\d{1,6}$/.test(retryAfter))
          headers['retry-after'] = retryAfter;
        response = Readable.from([body]);
        response.statusCode = result.status;
        response.headers = headers;
        response.complete = false;
        response.once('end', () => {
          response.complete = true;
        });
        req.res = response;
        onResponse(response);
      }

      async function run() {
        if (req.destroyed || finished) return;
        if (tooLarge) return deliver(failure(413, 'workbuddy_request_too_large'));
        if (
          requestOptions.method !== 'POST' ||
          typeof requestOptions.path !== 'string' ||
          !/^\/(?:[A-Za-z0-9_-]+\/)*chat\/completions$/.test(requestOptions.path)
        )
          return deliver(failure(400, 'workbuddy_host_path_invalid'));
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (_) {
          return deliver(failure(400, 'workbuddy_request_invalid'));
        } finally {
          chunks.length = 0;
        }
        if (
          !record(body) ||
          !Array.isArray(body.messages) ||
          body.messages.some((message) => !record(message) || typeof message.role !== 'string') ||
          (body.stream != null && typeof body.stream !== 'boolean')
        )
          return deliver(failure(400, 'workbuddy_request_invalid'));
        const plannerOptions = options.plannerOptions || {};
        let plan = planWorkBuddyWbipcRequest(body, plannerOptions);
        if (!plan.fits) return deliver(failure(413, 'workbuddy_request_too_large'));
        const fetch = (chat) =>
          client.request(
            {
              method: 'POST',
              path: requestOptions.path,
              headers: {
                'content-type': 'application/json',
                accept: chat.stream ? 'text/event-stream' : 'application/json',
              },
              body: Buffer.from(JSON.stringify(chat)),
            },
            { signal: controller.signal }
          );
        let result = await fetch(plan.body);
        if (req.destroyed || finished) return;
        if (isWorkBuddyWbipcPayloadTooLarge(result)) {
          plan = planWorkBuddyWbipcRequest(plan.body, {
            ...plannerOptions,
            force: true,
            targetBodyBytes: 256 * 1024,
            operationalInputTokens: 64 * 1024,
          });
          if (!plan.fits || !plan.changed)
            return deliver(failure(413, 'workbuddy_request_too_large'));
          result = await fetch(plan.body);
        }
        if (req.destroyed || finished) return;
        if (isWorkBuddyWbipcPayloadTooLarge(result))
          return deliver(failure(413, 'workbuddy_request_too_large'));
        if (!result || result.ok !== true)
          return deliver(
            failure(
              isWorkBuddyHostUnavailable(result?.status)
                ? 503
                : result?.status === 'timeout'
                  ? 504
                  : 401,
              'workbuddy_host_unavailable'
            )
          );
        if (
          !Number.isInteger(result.status) ||
          result.status < 200 ||
          result.status > 599 ||
          typeof result.body !== 'string' ||
          Buffer.byteLength(result.body) > MAX_RESPONSE_BYTES
        )
          return deliver(failure(502, 'workbuddy_host_response_invalid'));
        if (body.stream && result.status >= 200 && result.status < 300)
          result = { ...result, body: normalizeWorkBuddyChatSse(result.body) };
        if (Buffer.byteLength(result.body) > MAX_RESPONSE_BYTES)
          return deliver(failure(502, 'workbuddy_host_response_invalid'));
        deliver(result);
      }
      return req;
    },
  };
}

module.exports = { createWorkBuddyHttpTransport, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES };
