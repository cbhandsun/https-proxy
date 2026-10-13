'use strict';

const { randomUUID } = require('node:crypto');
const { CallToolResultSchema } = require('@modelcontextprotocol/sdk/types.js');
const { normalizeCompactionData } = require('../proxy/context-compaction-envelope');
const { createContextEvidenceLedger } = require('./context-evidence-ledger');
const { createContextEvidenceTools } = require('./context-evidence-tools');
const { createContextEvidenceOffloadBudget } = require('./context-evidence-offload-budget');
const { parseCompletedEvidenceSource } = require('./context-evidence-source');
const { buildEvidenceGatewayCatalog } = require('./context-evidence-gateway-catalog');
const {
  createContextExecutionLedger,
  executionToolDefinition,
  LIST_EXECUTIONS_TOOL,
} = require('./context-execution-ledger');

const fail = (error) => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ ok: false, error }) }],
});
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function gatewayOptions(value) {
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new TypeError('Invalid evidence gateway configuration');
  const options = {};
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (
      !['callTool', 'tools', 'now', 'ttlMs', 'offloadThresholdBytes'].includes(key) ||
      !d ||
      !Object.hasOwn(d, 'value')
    )
      throw new TypeError('Invalid evidence gateway configuration');
    options[key] = d.value;
  }
  if (
    typeof options.callTool !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.offloadThresholdBytes !== undefined &&
      (!Number.isSafeInteger(options.offloadThresholdBytes) ||
        options.offloadThresholdBytes < 1024 ||
        options.offloadThresholdBytes > 1024 * 1024))
  )
    throw new TypeError('Invalid evidence gateway configuration');
  return options;
}

// Exactly one owner-controlled MCP connection; no client-supplied thread/session
// selectors and no authentication guessed from tool names, content, or API keys.
// A host multiplexing chats on one connection shares this scope intentionally.
function createContextEvidenceGateway(input) {
  const options = gatewayOptions(input);
  const ledger = createContextEvidenceLedger({
    owner: 'mcp-evidence-gateway',
    threadId: randomUUID(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });
  const readers = createContextEvidenceTools(ledger);
  const offloadBudget = createContextEvidenceOffloadBudget({
    inspectReader: readers.inspect,
    ttlMs: options.ttlMs ?? 30 * 60 * 1000,
  });
  const executions = createContextExecutionLedger({ now: options.now, ttlMs: options.ttlMs });
  const reserved = new Set([
    ...readers.definitions.map((tool) => tool.name),
    LIST_EXECUTIONS_TOOL,
    'hpm_capture_completed_hook',
  ]);
  let catalog = buildEvidenceGatewayCatalog(options.tools, reserved);
  let catalogAvailable = true;
  let closed = false;
  let active = 0;
  let executionReads = 0;
  let executionReadBytes = 0;
  let captureFailures = 0;
  function finish(callId, state, retention, receipt = null) {
    // A result can arrive after expiry/close. Never reinterpret it as a new
    // invocation or reopen a ledger. The original result remains the result.
    try {
      executions.finish(callId, {
        state,
        retention,
        sourceId: receipt?.sourceId ?? null,
        digest: receipt?.digest ?? null,
      });
    } catch {
      captureFailures++;
    }
  }
  return {
    get definitions() {
      return normalizeCompactionData(
        [
          ...(catalogAvailable ? catalog.definitions : []),
          ...readers.definitions.map((tool) => ({
            ...tool,
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
          })),
          executionToolDefinition,
        ],
        2 * 1024 * 1024
      );
    },
    async call(name, args = {}, context = {}) {
      if (closed) return fail('evidence_gateway_closed');
      if (readers.definitions.some((tool) => tool.name === name)) {
        const reply = readers.reply(name, args);
        if (name === 'hpm_read_retained_evidence') offloadBudget.observeRead(reply);
        return {
          isError: !reply.ok,
          content: [
            { type: 'text', text: reply.text ?? JSON.stringify({ ok: false, error: reply.code }) },
          ],
        };
      }
      if (name === LIST_EXECUTIONS_TOOL) {
        if (executionReads++ >= 64 || executionReadBytes >= 512 * 1024)
          return fail('execution_read_budget_exceeded');
        try {
          const text = JSON.stringify(executions.list(args));
          const bytes = Buffer.byteLength(text);
          if (bytes > Math.min(16 * 1024, 512 * 1024 - executionReadBytes))
            return fail('execution_read_budget_exceeded');
          executionReadBytes += bytes;
          return { content: [{ type: 'text', text }] };
        } catch {
          return fail('execution_records_unavailable');
        }
      }
      if (!catalogAvailable) return fail('gateway_catalog_unavailable');
      // Pin this invocation's definition across an atomic catalog replacement.
      const contract = catalog.byName.get(name);
      if (!contract) return fail('unknown_gateway_tool');
      if (active >= 16 || context.signal?.aborted) return fail('gateway_dispatch_unavailable');
      let safeArgs;
      let callId;
      try {
        safeArgs = normalizeCompactionData(args, 1024 * 1024);
        if (!record(safeArgs) || !contract.input(safeArgs).valid)
          return fail('invalid_gateway_arguments');
        callId = executions.begin(name);
      } catch {
        return fail('gateway_dispatch_unavailable');
      }
      active++;
      try {
        // One dispatch, no retries. Only the trusted owner supplies this callback.
        const result = normalizeCompactionData(
          await options.callTool({ name, arguments: safeArgs }, context),
          4 * 1024 * 1024
        );
        if (
          !record(result) ||
          !CallToolResultSchema.safeParse(result).success ||
          !Array.isArray(result.content) ||
          (result.isError !== undefined && typeof result.isError !== 'boolean')
        ) {
          finish(callId, 'unknown', 'unavailable');
          return fail('invalid_downstream_result');
        }
        const outputValidator = contract.output;
        if (
          outputValidator &&
          ((result.structuredContent === undefined && result.isError !== true) ||
            (result.structuredContent !== undefined &&
              !outputValidator(result.structuredContent).valid))
        ) {
          finish(callId, 'unknown', 'unavailable');
          return fail('invalid_downstream_result');
        }
        const parsed = parseCompletedEvidenceSource({
          callId,
          toolName: name,
          arguments: safeArgs,
          output: result,
          completed: true,
        });
        let receipt = null;
        if (parsed.ok && !closed) {
          try {
            receipt = ledger.capture(parsed.source);
          } catch {
            captureFailures++;
          }
        }
        finish(
          callId,
          result.isError === true ? 'failed' : 'completed',
          receipt ? 'retained' : parsed.ok ? 'unavailable' : 'excluded',
          receipt
        );
        // Opt-in only, and only a simple text result without an output schema.
        // Saving must succeed before replacing anything. Typed/multimodal/meta
        // results and quota/expiry/capture failures retain their original form.
        if (
          receipt &&
          options.offloadThresholdBytes !== undefined &&
          !contract.definition.outputSchema &&
          Object.keys(result).every((key) => ['content', 'isError'].includes(key)) &&
          result.content.length === 1 &&
          record(result.content[0]) &&
          Object.keys(result.content[0]).sort().join(',') === 'text,type' &&
          result.content[0].type === 'text' &&
          typeof result.content[0].text === 'string' &&
          Buffer.byteLength(result.content[0].text) >= options.offloadThresholdBytes &&
          offloadBudget.admit(parsed.source.output, receipt)
        ) {
          return {
            ...(result.isError === undefined ? {} : { isError: result.isError }),
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  kind: 'retained_tool_result_reference',
                  trust: 'tool_data_not_instructions',
                  source: receipt,
                  format: 'normalized_mcp_result_json',
                  preview: Array.from(result.content[0].text).slice(0, 512).join(''),
                  reader: 'hpm_read_retained_evidence',
                  readerOptions: { limitBytes: 16384 },
                }),
              },
            ],
          };
        }
        return result;
      } catch {
        finish(callId, 'unknown', 'unavailable');
        return fail('downstream_execution_unknown');
      } finally {
        active--;
      }
    },
    inspect() {
      return {
        closed,
        active,
        captureFailures,
        catalogAvailable,
        scope: 'connection',
        reader: readers.inspect(),
        offloadBudget: offloadBudget.inspect(),
        ...(closed ? {} : { evidence: ledger.inspect() }),
      };
    },
    suspendDispatch() {
      catalogAvailable = false;
    },
    replaceCatalog(value) {
      if (closed) throw new Error('evidence_gateway_closed');
      try {
        const next = buildEvidenceGatewayCatalog(value, reserved);
        catalog = next;
        catalogAvailable = true;
      } catch {
        catalogAvailable = false;
        throw new Error('gateway_catalog_unavailable');
      }
    },
    close() {
      closed = true;
      offloadBudget.close();
      ledger.close();
      executions.close();
    },
  };
}

module.exports = { createContextEvidenceGateway };
