'use strict';

const { createHash, randomUUID } = require('node:crypto');
const {
  compactionTokenPrefix,
  normalizeCompactionData,
  invalidCompaction,
  validateLocalCompactionBinding,
} = require('./context-compaction-envelope');
const { parseResponsesHistory } = require('./responses-semantic-history');
const { selectLocalCompactionWindow } = require('./context-compaction-retention');
const {
  planLocalCompactionSummary,
  runLocalCompactionSummary,
} = require('./context-compaction-summary');
const { mergeCallIdDigests } = require('./context-call-id-lineage');
const {
  createLocalCompactionEvidence,
  normalizeLocalCompactionEvidenceReferences,
} = require('./context-compaction-evidence');
const { renewLocalCompactionReplay } = require('./context-compaction-lifecycle');
const { parseWorkBuddySummaryCompletion } = require('./workbuddy-summary-completion');
const { estimateTokensForValue } = require('./inline-media');
const { createCompactionUsageAccumulator } = require('./context-compaction-usage');
const { orderAuthenticatedCompactionReplay } = require('./context-local-compaction-order');

const LOCAL_SUMMARY_MARKER = '[HPM_LOCAL_COMPACTION_SUMMARY_V1]';
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function dataProperty(value, name) {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw invalidCompaction();
  return descriptor.value;
}

function prepareWorkBuddyCompactionInput(source, binding, store) {
  const sourceInput = dataProperty(source, 'input');
  if (!Array.isArray(sourceInput)) return { body: source, trigger: false, summaryTexts: [] };
  if (sourceInput.length > 65536) throw invalidCompaction();
  let relevant = false;
  for (let index = 0; index < sourceInput.length; index++)
    relevant ||= ['compaction', 'compaction_trigger'].includes(
      dataProperty(dataProperty(sourceInput, String(index)), 'type')
    );
  if (!relevant) return { body: source, trigger: false, summaryTexts: [] };
  const body = normalizeCompactionData(source, MAX_SOURCE_BYTES);
  const inputs = [];
  const summaryTexts = [];
  const authenticatedSummaryIndices = [];
  const tokens = [];
  let evidenceReceipts = [];
  let callIdDigests = [];
  let trigger = false;
  for (let index = 0; index < body.input.length; index++) {
    const item = body.input[index];
    if (item?.type === 'compaction_trigger') {
      if (
        trigger ||
        index !== body.input.length - 1 ||
        Object.keys(item).some((key) => !['type', 'id'].includes(key)) ||
        (item.id != null && (typeof item.id !== 'string' || item.id.length > 256))
      )
        throw invalidCompaction('invalid_compaction_trigger');
      trigger = true;
    } else if (item?.type === 'compaction') {
      if (
        typeof item.encrypted_content !== 'string' ||
        !compactionTokenPrefix(item.encrypted_content)
      )
        throw invalidCompaction('foreign_compaction_state');
      const {
        window,
        callIdDigests: restoredIds,
        evidenceReceipts: restoredEvidence = [],
      } = store.readState(item.encrypted_content, binding);
      tokens.push(item.encrypted_content);
      callIdDigests = mergeCallIdDigests(callIdDigests, restoredIds);
      evidenceReceipts = normalizeLocalCompactionEvidenceReferences([
        ...evidenceReceipts,
        ...restoredEvidence,
      ]);
      const windowStart = inputs.length;
      inputs.push(...window);
      for (const [restoredIndex, restored] of window.entries())
        if (
          restored.role === 'assistant' &&
          typeof restored.content === 'string' &&
          restored.content.startsWith(LOCAL_SUMMARY_MARKER + '\n')
        ) {
          summaryTexts.push(restored.content);
          authenticatedSummaryIndices.push(windowStart + restoredIndex);
        }
    } else {
      if (['reasoning', 'thought'].includes(item?.type) && item.encrypted_content)
        throw invalidCompaction('foreign_compaction_state');
      inputs.push(
        typeof item === 'string' ? { type: 'message', role: 'user', content: item } : item
      );
    }
    if (inputs.length > 2048) throw invalidCompaction();
  }
  if (trigger && body.previous_response_id != null)
    throw invalidCompaction('compaction_requires_full_history');
  body.input = orderAuthenticatedCompactionReplay(inputs, authenticatedSummaryIndices);
  // Admission applies to the expanded window, not only the small ciphertext.
  normalizeCompactionData(body, MAX_SOURCE_BYTES);
  return { body, trigger, summaryTexts, callIdDigests, evidenceReceipts, tokens };
}

function compactableWindow(body) {
  return selectLocalCompactionWindow(body.input);
}

async function produceWorkBuddyCompaction({
  body,
  binding,
  store,
  coordinator,
  requestSummary,
  prepareSummary,
  maxRequestBytes,
  maxInputTokens,
  signal,
  callIdDigests = [],
  artifactStore,
  evidenceReceipts = [],
  standalone = false,
  prepareWindow,
  authenticatedSummaryTexts = [],
}) {
  if (signal?.aborted) throw invalidCompaction('compaction_cancelled');
  validateLocalCompactionBinding(binding);
  if (
    !Number.isSafeInteger(maxRequestBytes) ||
    maxRequestBytes < 1 ||
    !Number.isSafeInteger(maxInputTokens) ||
    maxInputTokens < 1
  )
    throw invalidCompaction('compaction_source_too_large');
  const snapshot = normalizeCompactionData(body, MAX_SOURCE_BYTES);
  const sourceIds = parseResponsesHistory(snapshot.input, { fallbackId: () => '' })
    .flatMap((message) => message.parts)
    .filter(
      (part) => ['call', 'result'].includes(part.kind) && typeof part.id === 'string' && part.id
    )
    .map((part) => createHash('sha256').update(part.id).digest('hex'));
  const lineage = mergeCallIdDigests(callIdDigests, sourceIds);
  const { retained, removed, summaryGroups } = compactableWindow(snapshot);
  const knownSummaries = normalizeCompactionData(authenticatedSummaryTexts, MAX_SOURCE_BYTES);
  if (!Array.isArray(knownSummaries) || knownSummaries.some((text) => typeof text !== 'string'))
    throw invalidCompaction();
  let outputRetained = retained;
  const instructions = snapshot.instructions
    ? [{ type: 'message', role: 'system', content: snapshot.instructions }]
    : [];
  let window = [...instructions, ...retained];
  let evidence;
  let token;
  const accounting = createCompactionUsageAccumulator();
  let prefix = instructions;
  try {
    if (removed > 0) {
      const groups = instructions.length
        ? [[{ index: 0, item: instructions[0] }], ...summaryGroups]
        : summaryGroups;
      evidence = createLocalCompactionEvidence(
        groups,
        binding,
        artifactStore,
        { maxRequestBytes, maxInputTokens },
        evidenceReceipts
      );
      const plan = planLocalCompactionSummary(evidence.groups, {
        model: binding.model,
        maxRequestBytes,
        maxInputTokens,
        prepareSummary,
        // WorkBuddy's host API requires SSE even when the client's standalone
        // compact response is JSON. The bounded buffered pass remains tool-free
        // and must validate completion/usage before publishing local state.
        summaryStream: true,
      });
      const summary = await runLocalCompactionSummary(plan, {
        binding,
        coordinator,
        signal,
        requestSummary: async (request, summarySignal) => {
          const response = await requestSummary(request, summarySignal);
          if (
            response?.ok === true &&
            Number.isInteger(response.status) &&
            response.status >= 200 &&
            response.status < 300
          ) {
            const completion = parseWorkBuddySummaryCompletion(response.body, 128 * 1024);
            accounting.add(completion?.usage);
          }
          return response;
        },
      });
      const message = {
        type: 'message',
        role: 'assistant',
        content:
          LOCAL_SUMMARY_MARKER +
          '\n' +
          JSON.stringify({
            origin: 'hpm-local-compaction-v1',
            authority: 'untrusted_background',
            lossy: true,
            verification: 'not_verified',
            summary: summary.summary,
            taskState: summary.state,
            sourceDigest: summary.sourceDigest,
            ...(evidence.references.length ? { evidenceReceipts: evidence.references } : {}),
          }),
      };
      // Original instruction and user messages keep their roles and every unknown
      // field. Summary is data only; it never becomes system/developer authority.
      window = [...instructions, message, ...retained];
      prefix = [...instructions, message];
    }
    if (signal?.aborted) throw invalidCompaction('compaction_cancelled');
    const usage = accounting.result();
    if (standalone) {
      if (!usage.usage) throw invalidCompaction('compaction_usage_unavailable');
      if (typeof prepareWindow !== 'function') throw invalidCompaction();
      // Previously authenticated local summaries must remain inside the new
      // checkpoint, not escape as ordinary caller-controlled assistant text.
      // Original user/policy/tool items remain visible and unchanged.
      const authenticated = new Set(knownSummaries);
      const carried = retained.filter(
        (item) => item.role === 'assistant' && authenticated.has(item.content)
      );
      prefix = [...prefix, ...carried];
      outputRetained = retained.filter((item) => !carried.includes(item));
      if (!prefix.length) {
        prefix = [
          {
            type: 'message',
            role: 'assistant',
            content:
              LOCAL_SUMMARY_MARKER +
              '\n' +
              JSON.stringify({
                origin: 'hpm-local-compaction-v1',
                authority: 'untrusted_background',
                lossy: false,
                verification: 'not_verified',
                summary: 'No historical items were removed.',
                taskState: null,
                sourceDigest: null,
              }),
          },
        ];
      }
      window = [...prefix, ...outputRetained];
      const preparedWindow = prepareWindow(normalizeCompactionData(window, MAX_SOURCE_BYTES));
      const ceiling = preparedWindow?.__hpmDiagnostics?.contextBudget?.enabled
        ? Math.min(maxInputTokens, preparedWindow.__hpmDiagnostics.contextBudget.inputBudgetTokens)
        : maxInputTokens;
      if (
        !Number.isSafeInteger(ceiling) ||
        ceiling < 1 ||
        Buffer.byteLength(JSON.stringify(preparedWindow)) > maxRequestBytes ||
        estimateTokensForValue(preparedWindow) > ceiling
      )
        throw invalidCompaction('compaction_source_too_large');
    }
    token = store.issue(
      standalone ? prefix : window,
      binding,
      lineage,
      evidence?.references || evidenceReceipts
    );
    evidence?.commit();
    renewLocalCompactionReplay([token], binding, store, artifactStore, signal);
    return {
      token,
      discardEvidence: () => evidence?.discard(),
      response: {
        id: 'resp_hpm_' + randomUUID().replace(/-/g, ''),
        object: standalone ? 'response.compaction' : 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        model: snapshot.model || binding.model,
        output: [
          {
            id: 'cmp_hpm_' + randomUUID().replace(/-/g, ''),
            type: 'compaction',
            encrypted_content: token,
          },
          ...(standalone ? outputRetained : []),
        ],
        ...(standalone
          ? {
              usage: usage.usage,
              hpm_compaction: {
                origin: 'hpm-local-compaction-v1',
                usage_source: usage.source,
                upstream_calls: usage.calls,
                summary_reused: removed > 0 && usage.calls === 0,
                provider_billing: 'not_verified',
              },
            }
          : {}),
        error: null,
        incomplete_details: null,
      },
    };
  } catch (error) {
    if (token) store.discard(token, binding);
    evidence?.discard();
    throw error;
  } finally {
    evidence?.rollback();
  }
}

function compactionResponseEvents(response) {
  const pending = { ...response, status: 'in_progress', output: [] };
  const events = [
    ['response.created', { response: pending }],
    ['response.in_progress', { response: pending }],
    ['response.output_item.added', { output_index: 0, item: response.output[0] }],
    ['response.output_item.done', { output_index: 0, item: response.output[0] }],
    ['response.completed', { response }],
  ];
  return (
    events
      .map(
        ([type, data], sequence_number) =>
          `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number, ...data })}\n\n`
      )
      .join('') + 'data: [DONE]\n\n'
  );
}

module.exports = {
  LOCAL_SUMMARY_MARKER,
  prepareWorkBuddyCompactionInput,
  produceWorkBuddyCompaction,
  compactionResponseEvents,
};
