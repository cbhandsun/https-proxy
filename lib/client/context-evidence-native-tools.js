'use strict';

const { createContextEvidenceTools } = require('./context-evidence-tools');
const { encodeContextEvidenceOutput } = require('./context-evidence-output');
const { createContextEvidenceNativeDelivery } = require('./context-evidence-native-delivery');

// Native Code Mode may present a numeric type without its JSON Schema bounds.
// Repeat the existing constraints in model-visible prose; never repair input.
const LIST_ARGUMENT_GUIDANCE =
  'Arguments: start hpm_list_retained_evidence with {}. Optional limit must be an integer from 1 to 16; omission uses the existing default. For another index page, copy nextAfterSourceId into afterSourceId exactly. When nextAfterSourceId is null, stop listing; omit absent cursors, never send null or invent one.';
const READ_ARGUMENT_GUIDANCE =
  'Arguments: copy sourceId and digest exactly from the index. Optional offsetBytes must be a nonnegative safe integer; optional limitBytes must be an integer from 1 to 65536. Requesting a byte limit does not guarantee that many bytes: the result envelope is capped separately. Continue from page.nextOffsetBytes exactly; null means the source is complete. Never guess a cursor, coerce input or treat a failed result as recovered evidence.';

// Explicit host integration seam for thread/start.dynamicTools and
// item/tool/call replies. The host retains its own thread/turn/RPC dispatch;
// this capability has no transport, original-tool executor or capture method.
// Returning a result is not a completion/ingress acknowledgement.
function createContextEvidenceNativeTools(ledger) {
  const tools = createContextEvidenceTools(ledger);
  const definitions = tools.definitions.map((definition) => ({
    type: 'function',
    ...definition,
    description:
      definition.description +
      ' ' +
      (definition.name === 'hpm_list_retained_evidence'
        ? LIST_ARGUMENT_GUIDANCE
        : READ_ARGUMENT_GUIDANCE),
  }));
  function reply(name, argumentsValue) {
    const result = tools.reply(name, argumentsValue);
    if (result === null) return null;
    return encodeContextEvidenceOutput(
      result.text ? JSON.parse(result.text) : { ok: false, error: result.code }
    ).nativeResult;
  }
  return {
    definitions,
    reply,
    registration(options) {
      const plan = createContextEvidenceNativeDelivery(definitions, options);
      return {
        ...plan,
        guidance: plan.guidance + ' ' + LIST_ARGUMENT_GUIDANCE + ' ' + READ_ARGUMENT_GUIDANCE,
        reply(namespace, name, argumentsValue) {
          if (namespace !== plan.namespace)
            throw new TypeError('Native evidence namespace refused');
          return reply(name, argumentsValue);
        },
      };
    },
    inspect: tools.inspect,
  };
}

module.exports = { createContextEvidenceNativeTools };
