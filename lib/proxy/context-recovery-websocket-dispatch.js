'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { fingerprintContextData } = require('./context-recovery-fingerprint');
const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const unavailable = () => new Error('Recovery WebSocket dispatch unavailable');

// A coordinator owns a complete request-local history. The WS service may keep
// only the latest response in each lane, particularly with store:false. Project
// exact descendants onto that latest ID instead of resending the initial ID.
// Retain only hashes and causal metadata; never keep a second evidence payload.
function createRecoveryWebSocketDispatch(dispatch, deferred = [], historyFormat = 2) {
  if (typeof dispatch !== 'function') throw unavailable();
  const prefixInput = normalizeCompactionData(deferred, MAX_WIRE_BYTES);
  if (
    !Array.isArray(prefixInput) ||
    prefixInput.length > 16 ||
    prefixInput.some(
      (item) =>
        !record(item) ||
        Object.keys(item).sort().join(',') !== 'call_id,output,type' ||
        item.type !== 'function_call_output' ||
        !identity(item.call_id) ||
        typeof item.output !== 'string'
    ) ||
    new Set(prefixInput.map((item) => item.call_id)).size !== prefixInput.length
  )
    throw unavailable();
  let prior = null;
  let active = false;
  let failed = false;
  return async function send(input, context) {
    if (active || failed) throw unavailable();
    active = true;
    try {
      const request = normalizeRecoveryRequestBody('responses', input, historyFormat);
      if (record(request) && typeof request.input === 'string')
        request.input = [{ role: 'user', content: [{ type: 'input_text', text: request.input }] }];
      if (
        !record(request) ||
        !Array.isArray(request.input) ||
        !request.input.every(record) ||
        (request.previous_response_id != null && !identity(request.previous_response_id))
      )
        throw unavailable();
      if (prefixInput.length) {
        if (
          request.input.some((item) => prefixInput.some((prior) => item.call_id === prior.call_id))
        )
          throw unavailable();
        request.input = normalizeRecoveryRequestBody(
          'responses',
          {
            ...request,
            input: [...prefixInput, ...request.input],
          },
          historyFormat
        ).input;
      }
      const base = request.previous_response_id;
      // A public generation has a separate tool catalog. Even an empty
      // private response must never make it inherit a private provider ID.
      const catalog = fingerprintContextData(request.tools ?? []);
      let upstream = request;
      if (
        prior &&
        prior.base === base &&
        prior.catalog === catalog &&
        request.input.length >= prior.length &&
        fingerprintContextData(request.input.slice(0, prior.length).map(fingerprintContextData)) ===
          prior.prefix
      ) {
        upstream = {
          ...request,
          previous_response_id: prior.id,
          input: request.input.slice(prior.length),
        };
      }
      prior = null;
      const result = await dispatch(upstream, context);
      const fields = result && Object.getOwnPropertyDescriptors(result);
      if (
        fields?.statusCode?.value === 200 &&
        fields?.stream?.value === false &&
        Buffer.isBuffer(fields?.wire?.value) &&
        fields.wire.value.length <= MAX_WIRE_BYTES
      ) {
        const bytes = fields.wire.value;
        const text = bytes.toString('utf8');
        if (!Buffer.from(text).equals(bytes)) throw unavailable();
        const response = normalizeCompactionData(JSON.parse(text), MAX_WIRE_BYTES);
        if (
          record(response) &&
          response.status === 'completed' &&
          identity(response.id) &&
          Array.isArray(response.output) &&
          response.output.every(record)
        ) {
          const prefix = [...request.input, ...response.output].map(fingerprintContextData);
          prior = {
            base,
            catalog,
            id: response.id,
            length: prefix.length,
            prefix: fingerprintContextData(prefix),
          };
        }
      }
      return result;
    } catch {
      failed = true;
      prior = null;
      throw unavailable();
    } finally {
      active = false;
    }
  };
}

module.exports = { createRecoveryWebSocketDispatch };
