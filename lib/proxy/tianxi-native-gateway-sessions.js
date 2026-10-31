'use strict';

const { createHash } = require('node:crypto');
const { createTianxiNativeSession } = require('./tianxi-native-responses-session');
const { TIANXI_SDK_MODELS } = require('./tianxi-sdk-models');
const {
  createTianxiNativeCatalog,
  snapshot,
  stableJson,
} = require('./tianxi-native-responses-catalog');
const {
  hasTianxiCompactionTrigger,
  expandTianxiCompactionInput,
  buildLocalDeterministicSummary,
  createTianxiCompactionGuard,
  buildTianxiCompactionResponse,
} = require('./tianxi-compaction');

const DEFAULT_MODEL = 'tianxi/qwen3.8-flash';
// One shared protocol adapter for the authenticated Tianxi SDK catalog. Live
// acceptance evidence is tracked separately from model admission.
const MODELS = Object.freeze([
  DEFAULT_MODEL,
  ...TIANXI_SDK_MODELS.map((model) => model.alias).filter((alias) => alias !== DEFAULT_MODEL),
]);
const ALL_MODELS = Object.freeze([...MODELS, 'tianxi/super', 'tianxi/chat']);
const fail = (code) => {
  throw new Error(code);
};
function catalogKey(body) {
  const input = body.input.filter(
    (item) => item?.type === 'additional_tools' || item?.type === 'tool_search_output'
  );
  input.push({ role: 'user', content: 'catalog identity' });
  const catalog = createTianxiNativeCatalog(
    { ...(body.tools !== undefined ? { tools: body.tools } : {}), input },
    { allowPagedDocs: true }
  );
  return createHash('sha256')
    .update(stableJson([body.instructions ?? null, catalog.historyDefinitions]))
    .digest('hex');
}

// Call IDs bind continuations to an in-memory SDK task. A new user turn starts
// a new task from the complete client transcript. No server-side conversation
// state is silently invented or recovered after restart.
function createTianxiNativeGatewaySessions({
  run,
  summarize,
  now = Date.now,
  maxSessions = 64,
  maxActive = 4,
  ttlMs = 300000,
  recoverOrphanContinuations = false,
  onCatalog,
} = {}) {
  const records = new Set();
  const calls = new Map();
  const starts = new Map();
  const compactionGuard = createTianxiCompactionGuard({ now });
  let closing = false;
  function sweep() {
    for (const record of records) {
      if (now() - record.touched < ttlMs) continue;
      record.session.cancel();
      for (const id of record.ids) calls.delete(id);
      records.delete(record);
      starts.delete(record.startKey);
    }
  }
  async function request(raw, owner, signal) {
    if (closing) fail('tianxi_native_gateway_closed');
    sweep();
    const body = snapshot(raw);
    if (
      !ALL_MODELS.includes(body?.model) ||
      typeof body.stream !== 'boolean' ||
      !Array.isArray(body.input) ||
      !body.input.length ||
      body.input.length > 4096 ||
      typeof owner !== 'string' ||
      !owner.length ||
      owner.length > 256
    )
      fail('tianxi_native_request_invalid');
    if (
      body.previous_response_id ||
      body.background === true ||
      body.conversation ||
      body.truncation === 'auto'
    )
      fail('tianxi_native_feature_unsupported');

    if (hasTianxiCompactionTrigger(body.input)) {
      const guardKey = `${body.model}\0${body.prompt_cache_key || owner}`;
      compactionGuard.check(guardKey);
      try {
        // Validate any prior compaction items before generating a new checkpoint
        const expanded = expandTianxiCompactionInput(body.input);
        let summaryText = '';
        if (typeof summarize === 'function') {
          summaryText = await summarize(body, { owner, signal });
        }
        if (typeof summaryText !== 'string' || !summaryText.trim()) {
          summaryText = buildLocalDeterministicSummary(body.input);
        }
        compactionGuard.recordSuccess(guardKey);
        return buildTianxiCompactionResponse(body.model, summaryText, {
          standalone: false,
          inputText: JSON.stringify(expanded),
        });
      } catch (err) {
        compactionGuard.recordFailure(guardKey);
        throw err;
      }
    }

    if (
      body.input.some(
        (item) => item?.type === 'compaction' || item?.type === 'compaction_summary'
      )
    ) {
      body.input = expandTianxiCompactionInput(body.input);
    }

    const lastUser = body.input.findLastIndex((item) => item?.role === 'user');
    const lastOutput = body.input.findLastIndex((item) =>
      ['function_call_output', 'custom_tool_call_output', 'tool_call_output'].includes(item?.type)
    );
    let continuation = lastOutput > lastUser;
    let record;
    if (continuation) {
      record = calls.get(body.input[lastOutput]?.call_id);
      if (!record) {
        for (let i = lastOutput - 1; i >= 0; i--) {
          const id = body.input[i]?.call_id;
          if (id && calls.has(id)) {
            record = calls.get(id);
            break;
          }
        }
      }
      if (record && (record.owner !== owner || record.model !== body.model)) {
        fail('tianxi_native_continuation_not_found');
      }
      if (!record) {
        if (recoverOrphanContinuations) {
          // Proxy restarted or previous SDK process ended: seamlessly cold-start
          // a fresh session from the complete transcript in body.input.
          continuation = false;
        } else {
          fail('tianxi_native_continuation_not_found');
        }
      } else if (record.key !== catalogKey(body) || body.tool_choice === 'none') {
        fail('tianxi_native_catalog_changed');
      }
    }
    const evictRecord = (target) => {
      if (!target) return;
      target.session?.cancel?.();
      target.done = true;
      for (const id of target.ids) calls.delete(id);
      records.delete(target);
      starts.delete(target.startKey);
    };
    const spawnSessionRecord = (startKey) => {
      if (recoverOrphanContinuations) {
        // Reclaim any older unfinished session belonging to the same owner
        // before checking capacity so retries or new turns never exhaust slots.
        for (const existing of records) {
          if (existing.owner === owner && !existing.done) {
            evictRecord(existing);
          }
        }
      }
      if (
        records.size >= maxSessions ||
        [...records].filter((item) => !item.done).length >= maxActive
      )
        fail('tianxi_native_capacity');
      const key = catalogKey(body);
      const created = {
        owner,
        model: body.model,
        key,
        ids: new Set(),
        touched: now(),
        done: false,
        startKey,
      };
      created.session = createTianxiNativeSession({
        body,
        owner,
        allowHistory: true,
        onCatalog,
        ...(run ? { run } : {}),
        onCall(call) {
          created.ids.add(call.call_id);
          calls.set(call.call_id, created);
        },
      });
      records.add(created);
      starts.set(startKey, created);
      created.initial = created.session.next();
      created.session.done.finally(() => {
        created.done = true;
      });
      return created;
    };
    if (!continuation) {
      const startKey = createHash('sha256')
        .update(stableJson([owner, body]))
        .digest('hex');
      const previous = starts.get(startKey);
      if (previous) return previous.initial;
      record = spawnSessionRecord(startKey);
    }
    const abort = () => record.session.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      let result = continuation
        ? await record.session.resume(body.input, owner, body.model)
        : await record.initial;
      if (result?.status === 'failed') {
        evictRecord(record);
        if (continuation && recoverOrphanContinuations && !signal?.aborted) {
          const fallbackStartKey = createHash('sha256')
            .update(stableJson([owner, body, 'fallback', now()]))
            .digest('hex');
          record = spawnSessionRecord(fallbackStartKey);
          result = await record.initial;
          if (result?.status === 'failed') {
            evictRecord(record);
          }
        }
      }
      record.touched = now();
      return result;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  return {
    request,
    sweep,
    async close() {
      closing = true;
      for (const record of records) record.session.cancel();
      await Promise.all([...records].map((record) => record.session.done));
      records.clear();
      calls.clear();
      starts.clear();
    },
  };
}
module.exports = { MODELS, ALL_MODELS, DEFAULT_MODEL, createTianxiNativeGatewaySessions };
