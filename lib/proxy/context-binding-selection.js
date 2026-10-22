'use strict';

const { createHash } = require('node:crypto');
const { publishedBindingFrontiers } = require('./context-responses-observed-echo');
const { isCodexSummaryReceipt } = require('./context-recovery-codex-summary');
const { isClaudeSummaryReceipt } = require('./context-recovery-claude-summary');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const failure = (code) => ({ ok: false, code });

// Pure selection over owner-validated fingerprints and causal indices. Used
// by both actual begin and non-mutating combined online/offline admission.
// No token, snapshot, time, byte, budget or visibility state is changed here.
function selectContextBinding(
  data,
  { snapshots, windows, compactionInputs, responses, summaryResponses },
  compaction
) {
  const summaryContinuation =
    compaction && data.codexSummary === true && isCodexSummaryReceipt(data.previousResponseId);
  if (
    compaction &&
    (data.protocol !== 'responses' ||
      (data.previousResponseId !== undefined && !summaryContinuation))
  )
    return failure('context_binding_compaction_unsupported');
  let parent = null;
  let reason = 'isolated_request';
  let matches;
  let historyMatches;
  let observedSummaryDescendant = false;
  const prefixes = compaction ? data.continuityPrefixes : data.prefixes;
  const index = compaction ? compactionInputs : windows;
  for (let i = prefixes.length - 1; i >= 0; i--) {
    const found = index.get(prefixes[i]);
    if (found?.size) {
      historyMatches = found;
      break;
    }
  }
  if (data.previousResponseId !== undefined) {
    matches = summaryContinuation
      ? summaryResponses?.get(digest(data.continuityScope + '\0' + data.previousResponseId))
      : responses.get(digest(data.scope + '\0' + data.previousResponseId));
    if (!matches?.size) return failure('context_binding_previous_unavailable');
    const explicit = matches.size === 1 ? snapshots.get([...matches][0]) : null;
    const explicitAncestors = new Set();
    for (let node = explicit; node; node = snapshots.get(node.parentId))
      explicitAncestors.add(node.id);
    // Claude echoes its summary receipt throughout the new public window.
    // Prefer a uniquely observed descendant only when its ancestry reaches
    // that exact receipt; unrelated or ambiguous histories still conflict.
    if (
      data.protocol === 'claude' &&
      isClaudeSummaryReceipt(data.previousResponseId) &&
      explicit &&
      historyMatches?.size === 1 &&
      !historyMatches.has(explicit.id)
    ) {
      for (
        let node = snapshots.get([...historyMatches][0]);
        node;
        node = snapshots.get(node.parentId)
      ) {
        if (node.id === explicit.id) {
          observedSummaryDescendant = true;
          matches = historyMatches;
          break;
        }
      }
    }
    const exactDescendant =
      explicit &&
      publishedBindingFrontiers(explicit).some((frontier) => data.prefixes.includes(frontier)) &&
      historyMatches &&
      [...historyMatches].every((id) => explicitAncestors.has(id));
    if (
      historyMatches &&
      (historyMatches.size !== matches.size ||
        [...historyMatches].some((id) => !matches.has(id))) &&
      !exactDescendant &&
      !observedSummaryDescendant
    )
      return failure('context_binding_conflict');
  } else matches = historyMatches;
  if (matches?.size === 1) {
    parent = snapshots.get([...matches][0]);
    reason = 'observed_continuation';
  } else if (matches?.size > 1) reason = 'ambiguous_continuation';
  if (compaction) {
    if (!parent)
      return failure(
        matches?.size
          ? 'context_binding_compaction_ambiguous'
          : 'context_binding_compaction_unobserved'
      );
    if (!data.compactionPolicyOmitted && data.policyFingerprint !== parent.policyFingerprint)
      return failure('context_binding_compaction_policy_conflict');
  }
  return { ok: true, parent, reason, observedSummaryDescendant };
}

function indexBindingSnapshots(snapshots) {
  const windows = new Map(),
    compactionInputs = new Map(),
    responses = new Map(),
    summaryResponses = new Map();
  const add = (index, key, id) => {
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(id);
  };
  for (const snapshot of snapshots.values()) {
    if (!snapshot.committed) continue;
    if (snapshot.anchored) {
      for (const frontier of publishedBindingFrontiers(snapshot))
        add(windows, frontier, snapshot.id);
      for (const frontier of publishedBindingFrontiers(snapshot, true))
        add(compactionInputs, frontier, snapshot.id);
    }
    if (snapshot.responseKey !== null) add(responses, snapshot.responseKey, snapshot.id);
    if (snapshot.summaryResponseKey)
      add(summaryResponses, snapshot.summaryResponseKey, snapshot.id);
  }
  return { snapshots, windows, compactionInputs, responses, summaryResponses };
}

module.exports = { selectContextBinding, indexBindingSnapshots };
