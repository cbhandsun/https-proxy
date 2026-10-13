'use strict';

const { normalizeCompactionData } = require('../proxy/context-compaction-envelope');
const { createContextEvidenceLedger } = require('./context-evidence-ledger');
const { createContextEvidenceTools } = require('./context-evidence-tools');
const { parseCompletedEvidenceSource } = require('./context-evidence-source');

// This operation is intentionally absent from tools/list. Only the trusted host
// hook dispatcher can address it; plugin policy exposes the two readers only.
const CAPTURE_HOOK_TOOL = 'hpm_capture_completed_hook';
const MAX_EVENT_BYTES = 1024 * 1024 + 16384;
const identity = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code) => ({ ok: false, code });

function parseCompletedHook(value) {
  let event;
  try {
    event = normalizeCompactionData(value, MAX_EVENT_BYTES);
  } catch {
    return failure('invalid_hook_event');
  }
  const keys = 'hook_event_name,session_id,tool_input,tool_name,tool_response,tool_use_id';
  if (
    !record(event) ||
    Object.keys(event).sort().join(',') !== keys ||
    event.hook_event_name !== 'PostToolUse' ||
    !identity(event.session_id) ||
    !identity(event.tool_use_id) ||
    typeof event.tool_name !== 'string' ||
    !/^[a-zA-Z0-9_.:-]{1,128}$/.test(event.tool_name) ||
    !record(event.tool_input)
  )
    return failure('invalid_hook_event');
  const parsed = parseCompletedEvidenceSource({
    callId: event.tool_use_id,
    toolName: event.tool_name,
    arguments: event.tool_input,
    output: event.tool_response,
    completed: true,
  });
  if (!parsed.ok) {
    const codes = {
      invalid_evidence_source: 'invalid_hook_event',
      evidence_arguments_too_large: 'hook_arguments_too_large',
      evidence_output_too_large: 'hook_output_too_large',
    };
    return failure(codes[parsed.code] ?? parsed.code);
  }
  return { ...parsed, sessionId: event.session_id };
}

// One stdio connection owns one in-memory ledger. Identity is host metadata,
// never a model argument. There is no filesystem, HTTP, credential or transcript
// access here. This is not a boundary against arbitrary same-user shell access.
function createContextEvidenceHookSession() {
  let threadId = null;
  let ledger = null;
  let readers = null;
  let closed = false;
  const definitions = createContextEvidenceTools({ list() {}, read() {} }).definitions;
  function bind(meta) {
    let safe;
    try {
      safe = normalizeCompactionData(meta, 4096);
    } catch {
      return false;
    }
    if (
      closed ||
      !record(safe) ||
      !identity(safe.threadId) ||
      (threadId !== null && threadId !== safe.threadId)
    )
      return false;
    if (threadId === null) {
      threadId = safe.threadId;
      ledger = createContextEvidenceLedger({ owner: 'codex-local-evidence', threadId });
      readers = createContextEvidenceTools(ledger);
    }
    return true;
  }
  return {
    definitions,
    call(name, args, meta) {
      if (!definitions.some((tool) => tool.name === name) && name !== CAPTURE_HOOK_TOOL)
        return failure('unknown_evidence_operation');
      if (!bind(meta)) return failure('evidence_session_unavailable');
      if (name !== CAPTURE_HOOK_TOOL) return readers.reply(name, args);
      const parsed = parseCompletedHook(args);
      if (!parsed.ok) return parsed;
      if (parsed.sessionId !== threadId) return failure('evidence_session_unavailable');
      try {
        ledger.capture(parsed.source);
      } catch {
        return failure('evidence_capture_unavailable');
      }
      // Empty JSON feedback: no result rewriting or instruction promotion.
      return { ok: true, code: 'evidence_captured', text: '{}' };
    },
    inspect() {
      return { bound: threadId !== null, closed, ...(ledger && !closed ? ledger.inspect() : {}) };
    },
    close() {
      closed = true;
      ledger?.close();
    },
  };
}

module.exports = { CAPTURE_HOOK_TOOL, parseCompletedHook, createContextEvidenceHookSession };
