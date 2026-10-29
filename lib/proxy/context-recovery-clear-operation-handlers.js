'use strict';

const { readJsonBodyFromRequest } = require('./management-utils');
const { storageData } = require('./context-recovery-storage-contract');
const { validOperationId } = require('./context-recovery-clear-operations');

function createClearOperationHandlers({ sendJson, operations }) {
  function send(res, status, value) {
    if (res.destroyed || res.writableEnded) return;
    try {
      sendJson(res, status, value);
    } catch {
      /* delivery failure never replays the operation */
    }
  }
  function reply(res, value, successStatus = 200) {
    if (res.destroyed || res.writableEnded) return;
    const status = value.ok
      ? successStatus
      : value.code === 'context_recovery_operation_unknown'
        ? 404
        : 409;
    send(res, status, value);
  }
  function failure(res, status = 400) {
    send(res, status, { ok: false, code: 'context_recovery_operation_invalid' });
  }
  function body(req, res, expectedMethod, parse, run) {
    if (req.method !== expectedMethod) return failure(res, 405);
    let hasBody = false;
    req.on('data', (chunk) => {
      if (chunk.length > 0) hasBody = true;
    });
    readJsonBodyFromRequest(
      req,
      (error, input) => {
        let parsed;
        try {
          if (error || !hasBody) throw new TypeError();
          parsed = parse(storageData(input, 128));
        } catch {
          failure(res);
          return;
        }
        if (req.aborted || res.destroyed || res.writableEnded) return;
        try {
          reply(res, run(parsed), 202);
        } catch {
          // Sending a reply can fail after start. It must never trigger another
          // execution or expose a native error; query the previously issued ID.
          if (!res.headersSent) {
            try {
              failure(res, 503);
            } catch {
              /* response already unavailable */
            }
          }
        }
      },
      { maxBytes: 128 }
    );
  }
  function confirmedOperationId(value) {
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'confirm,operationId' ||
      value.confirm !== true ||
      !validOperationId(value.operationId)
    )
      throw new TypeError();
    return value.operationId;
  }
  return {
    handleLocalContextRecoveryClearPrepareRequest(req, res) {
      body(
        req,
        res,
        'POST',
        (value) => {
          if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            Object.keys(value).length !== 0
          )
            throw new TypeError();
          return null;
        },
        () => operations.prepare()
      );
    },
    handleLocalContextRecoveryClearStartRequest(req, res) {
      body(req, res, 'POST', confirmedOperationId, (id) => operations.start(id));
    },
    handleLocalContextRecoveryClearCancelRequest(req, res) {
      body(req, res, 'POST', confirmedOperationId, (id) => operations.cancel(id));
    },
    handleLocalContextRecoveryClearStatusRequest(req, res) {
      if (req.method !== 'GET') return failure(res, 405);
      if (req.aborted || res.destroyed || res.writableEnded) return;
      let id;
      try {
        if (typeof req.url !== 'string' || req.url.length > 200) throw new TypeError();
        const url = new URL(req.url, 'http://127.0.0.1');
        const entries = [...url.searchParams];
        if (
          entries.length !== 1 ||
          entries[0][0] !== 'operationId' ||
          !validOperationId(entries[0][1]) ||
          url.hash
        )
          throw new TypeError();
        id = entries[0][1];
      } catch {
        failure(res);
        return;
      }
      try {
        reply(res, operations.inspect(id));
      } catch {
        try {
          failure(res, 503);
        } catch {
          /* response unavailable */
        }
      }
    },
  };
}

module.exports = { createClearOperationHandlers };
