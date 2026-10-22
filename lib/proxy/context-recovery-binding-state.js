'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { parseBindingWindow } = require('./context-binding-window');
const { recoveryHistoryRequestLimit } = require('./context-recovery-history-request');
const { CODEX_TOOLS_IDENTITY_FORMAT } = require('./context-recovery-codex-tools');

const { recoveryComponentTtl } = require('./context-recovery-limits');
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value) => typeof value === 'string' && /^hbs_[a-f0-9]{32}$/.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
function bindingStateFailure() {
  return Object.assign(new TypeError('invalid_context_binding_state'), {
    code: 'invalid_context_binding_state',
  });
}
function exact(value, fields) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== fields
  )
    throw bindingStateFailure();
}
function parseContextBindingState(input, expected, maximum) {
  try {
    const state = normalizeCompactionData(input, 2 * 1024 * 1024);
    const format = state?.format === 3 ? 3 : 2;
    const expectedFormat = expected.format ?? expected.historyFormat;
    const ttlMs = recoveryComponentTtl(state?.version);
    const hasIdentityFormat = state && Object.hasOwn(state, 'identityFormat');
    exact(
      state,
      ([2, 3].includes(state?.format)
        ? 'continuityScope,format,kind,observedAt,policyFingerprint,protocol,rootId,scope,snapshots,version'
        : 'continuityScope,kind,observedAt,policyFingerprint,protocol,rootId,scope,snapshots,version'
      )
        .split(',')
        .concat(hasIdentityFormat ? ['identityFormat'] : [])
        .sort()
        .join(',')
    );
    if (
      state.kind !== 'binding-root' ||
      state.identityFormat !== expected.identityFormat ||
      (hasIdentityFormat &&
        (state.identityFormat !== CODEX_TOOLS_IDENTITY_FORMAT ||
          state.protocol !== 'responses' ||
          ![2, 3].includes(state.format))) ||
      (expectedFormat !== undefined && format !== expectedFormat) ||
      !['chat', 'responses', 'claude'].includes(state.protocol) ||
      ['scope', 'continuityScope', 'policyFingerprint', 'protocol'].some(
        (key) => state[key] !== expected[key]
      ) ||
      !integer(state.observedAt) ||
      state.observedAt > Number.MAX_SAFE_INTEGER - ttlMs ||
      !id(state.rootId) ||
      !Array.isArray(state.snapshots) ||
      !state.snapshots.length ||
      state.snapshots.length > maximum
    )
      throw bindingStateFailure();
    const snapshots = new Map();
    for (const source of state.snapshots) {
      const hasEcho =
        Object.hasOwn(source, 'echoFrontier') || Object.hasOwn(source, 'echoContinuityFrontier');
      const hasSummaryResponse = Object.hasOwn(source, 'summaryResponseKey');
      exact(
        source,
        'anchored,anchoredPrefix,bytes,committed,continuityFrontier,continuityScope,count,createdAt,' +
          (hasEcho ? 'echoContinuityFrontier,echoFrontier,' : '') +
          'expiresAt,frontier,id,parentId,policyFingerprint,protocol,publishedContinuityFrontier,publishedFrontier,responseKey,scope' +
          (hasSummaryResponse ? ',summaryResponseKey' : '') +
          ([2, 3].includes(state.format) ? ',window' : '')
      );
      const parent = source.parentId === null ? null : snapshots.get(source.parentId);
      if (
        !id(source.id) ||
        snapshots.has(source.id) ||
        source.committed !== true ||
        (hasSummaryResponse &&
          (source.protocol !== 'responses' ||
            !hash(source.summaryResponseKey) ||
            source.responseKey === null)) ||
        (hasEcho &&
          (source.protocol !== 'responses' ||
            !hash(source.echoFrontier) ||
            !hash(source.echoContinuityFrontier))) ||
        ['scope', 'continuityScope', 'policyFingerprint', 'protocol'].some(
          (key) => source[key] !== state[key]
        ) ||
        ![
          'scope',
          'continuityScope',
          'policyFingerprint',
          'frontier',
          'continuityFrontier',
          'publishedFrontier',
          'publishedContinuityFrontier',
        ].every((key) => hash(source[key])) ||
        (source.responseKey !== null && !hash(source.responseKey)) ||
        !integer(source.createdAt) ||
        source.createdAt > state.observedAt ||
        !integer(source.expiresAt) ||
        source.expiresAt !== source.createdAt + ttlMs ||
        source.expiresAt <= state.observedAt ||
        !integer(source.count) ||
        source.count > 16384 ||
        !integer(source.bytes) ||
        source.bytes < 1 ||
        source.bytes > recoveryHistoryRequestLimit(format) ||
        typeof source.anchoredPrefix !== 'boolean' ||
        typeof source.anchored !== 'boolean' ||
        (source.anchoredPrefix && (!source.anchored || !parent?.anchored)) ||
        (source.parentId === null
          ? snapshots.size !== 0 || source.id !== state.rootId
          : !parent || source.createdAt < parent.createdAt)
      )
        throw bindingStateFailure();
      if ([2, 3].includes(state.format)) {
        const window = parseBindingWindow(source.window);
        if (
          (window.kind === 'full' && window.count <= source.count) ||
          (window.kind === 'delta' &&
            (source.parentId === null ||
              parent?.window?.count == null ||
              window.count <= parent.window.count + source.count)) ||
          (window.kind === 'compaction' && (source.protocol !== 'responses' || window.count < 1)) ||
          (window.kind === 'summary' &&
            (!['claude', 'responses'].includes(source.protocol) ||
              !parent?.responseKey ||
              !source.anchoredPrefix ||
              source.count < 1 ||
              window.count <= source.count))
        )
          throw bindingStateFailure();
      }
      snapshots.set(source.id, source);
    }
    return state;
  } catch {
    throw bindingStateFailure();
  }
}

module.exports = { bindingStateFailure, parseContextBindingState };
