'use strict';

const {
  TOOL_DISCOVERY_NAME,
  isContextToolCatalog,
  isContextToolCallId,
} = require('./context-tool-catalog');
const {
  CONTEXT_ARTIFACT_TOOL_NAME,
  appendContextArtifactTool,
} = require('./context-artifact-tool');
const { collectContextArtifactReferences } = require('./context-artifact-references');
const {
  captureContextHistorySnapshot,
  commitContextHistoryPlan,
} = require('./context-history-branch');
const {
  parseWorkBuddyToolCompletion,
  encodeWorkBuddyToolCompletion,
} = require('./workbuddy-mixed-tool-phase');
const { planWorkBuddyWbipcRequest } = require('./workbuddy-context-planner');
const { planWorkBuddyContextRecovery } = require('./workbuddy-context-recovery');
const { estimateTokensForValue } = require('./inline-media');

// Schemas, recovered evidence and the private history window are admitted as
// one batch. The proxy consumes only its own discovery/read calls; original
// external calls stay with the caller-owned execution phase.
function planWorkBuddyToolDiscovery(options) {
  const {
    responseBody,
    chatBody,
    catalog,
    owner,
    scope,
    plannerOptions,
    recoveryGuard,
    targetBodyBytes,
    maxBytes,
    internalOnly = false,
  } = options;
  if (!catalog) return { matched: false };
  if (!isContextToolCatalog(catalog))
    return { matched: true, ok: false, reason: 'invalid_context_tool_catalog' };
  const completion = parseWorkBuddyToolCompletion(responseBody, chatBody.stream === true, maxBytes);
  const choice = completion?.choices?.[0],
    message = choice?.message;
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const discovery = calls.filter((call) => call?.function?.name === TOOL_DISCOVERY_NAME);
  if (discovery.length === 0) return { matched: false };
  const invalid = (reason) => ({ matched: true, ok: false, reason });
  const history = plannerOptions.historyBranch;
  const snapshot = captureContextHistorySnapshot(history, chatBody, owner, scope);
  if (!snapshot) return invalid('invalid_context_history_branch');
  const requiredName = chatBody.tool_choice?.function?.name || chatBody.tool_choice?.name;
  if (
    completion.choices.length !== 1 ||
    choice.finish_reason !== 'tool_calls' ||
    message.role !== 'assistant' ||
    message.function_call != null ||
    message.refusal ||
    chatBody.tool_choice === 'none' ||
    (requiredName && calls.some((call) => call?.function?.name !== requiredName)) ||
    (message.content != null && typeof message.content !== 'string') ||
    calls.some(
      (call) => ![TOOL_DISCOVERY_NAME, CONTEXT_ARTIFACT_TOOL_NAME].includes(call?.function?.name)
    )
  )
    return invalid('context_tool_discovery_invalid_turn');
  const ids = new Set();
  for (const entry of chatBody.messages) {
    if (typeof entry.tool_call_id === 'string') ids.add(entry.tool_call_id);
    for (const call of Array.isArray(entry.tool_calls) ? entry.tool_calls : [])
      if (typeof call.id === 'string') ids.add(call.id);
  }
  for (const call of calls) {
    if (
      call.type !== 'function' ||
      !isContextToolCallId(call.id) ||
      ids.has(call.id) ||
      history.hasToolCallId(call.id)
    )
      return invalid('context_tool_discovery_invalid_turn');
    ids.add(call.id);
  }
  const staged = catalog.stage(discovery, owner, scope, plannerOptions.signal);
  if (!staged.ok) return invalid(staged.reason);
  const store = plannerOptions.artifactStore;
  let transaction;
  try {
    transaction = store?.beginTransaction?.(owner, scope);
    const turn = { role: 'assistant', content: message.content ?? null, tool_calls: discovery };
    const freshMessages = [turn, ...staged.messages];
    const protectedMessages = new Set([
      ...(plannerOptions.protectedMessages instanceof Set ? plannerOptions.protectedMessages : []),
      ...freshMessages,
    ]);
    const originalHasRead = chatBody.tools?.some(
      (tool) => tool?.function?.name === CONTEXT_ARTIFACT_TOOL_NAME
    );
    const candidate = {
      ...chatBody,
      messages: [...chatBody.messages, ...freshMessages],
      tools: internalOnly
        ? chatBody.tools
        : originalHasRead
          ? appendContextArtifactTool(staged.tools)
          : staged.tools,
    };
    const planning = {
      ...plannerOptions,
      artifactStore: transaction || store,
      historyCommit: false,
      force: true,
      preserveToolSchemas: true,
      protectedMessages,
      targetBodyBytes,
    };
    const artifacts = calls.filter((call) => call.function.name === CONTEXT_ARTIFACT_TOOL_NAME);
    let recovery = null,
      plan;
    if (artifacts.length > 0) {
      const artifactCompletion = {
        ...completion,
        choices: [
          { ...choice, message: { role: 'assistant', content: null, tool_calls: artifacts } },
        ],
      };
      const wire = encodeWorkBuddyToolCompletion(artifactCompletion, chatBody.stream === true);
      const accepted = recoveryGuard.accept(wire, chatBody.stream === true, maxBytes);
      if (!accepted.ok) return invalid(accepted.reason || 'context_artifact_invalid_turn');
      recovery = planWorkBuddyContextRecovery({
        responseBody: wire,
        chatBody: candidate,
        store: plannerOptions.artifactReadStore || store,
        owner,
        maxBytes,
        plannerOptions: planning,
        targetBodyBytes,
      });
      if (!recovery.ok || !recovery.plan) return invalid('context_artifact_invalid_turn');
      if (internalOnly && recovery.resolvedCount !== recovery.attemptedCount)
        return invalid('context_artifact_recovery_failed');
      plan = recovery.plan;
    } else plan = planWorkBuddyWbipcRequest(candidate, planning);
    const stagedEntries = transaction?.stats().stagedEntries || 0;
    const committed =
      plan.fits && !plannerOptions.signal?.aborted
        ? catalog.publish(staged.ticket, () =>
            commitContextHistoryPlan(
              history,
              snapshot,
              plan.body,
              () =>
                transaction
                  ? transaction.commit(collectContextArtifactReferences(plan.body.messages, scope))
                  : { ok: true },
              plannerOptions.signal
            )
          )
        : null;
    const admitted = committed?.ok === true;
    const returned = admitted ? plan.body : history.snapshot().body || chatBody;
    const returnedBytes = Buffer.byteLength(JSON.stringify(returned));
    return {
      matched: true,
      ok: true,
      resolvedCount: recovery?.resolvedCount || 0,
      attemptedCount: recovery?.attemptedCount || 0,
      unavailableCount: recovery?.unavailableCount || 0,
      budgetExceededCount: recovery?.budgetExceededCount || 0,
      plan: {
        ...plan,
        body: returned,
        fits: admitted,
        changed: admitted,
        diagnostics: {
          ...plan.diagnostics,
          historyTransactionStatus: admitted ? 'committed' : 'rolled_back',
          historyVersion: history.stats().version,
          artifactTransactionStatus: admitted ? 'committed' : 'rolled_back',
          artifactsStored: admitted ? committed.publication?.committedEntries || 0 : 0,
          artifactsStaged: stagedEntries,
          toolDiscoveryRound: catalog.stats().rounds,
          toolSchemasLoaded: admitted ? staged.loadedCount : 0,
          toolSchemaBytes: Buffer.byteLength(JSON.stringify(returned.tools || [])),
          ...(!admitted
            ? {
                reason:
                  committed?.reason ||
                  (plannerOptions.signal?.aborted
                    ? 'context_tool_discovery_cancelled'
                    : plan.diagnostics.reason || 'context_tool_publication_failed'),
                attemptedFinalBodyBytes: plan.diagnostics.finalBodyBytes,
                finalBodyBytes: returnedBytes,
                finalEstimatedTokens: estimateTokensForValue(returned),
                cleanupSavedBytes: 0,
                droppedMessages: 0,
                continuationSummaryAdded: false,
                growthReserveSatisfied: false,
              }
            : {}),
        },
      },
    };
  } finally {
    transaction?.rollback();
    catalog.rollback(staged.ticket);
  }
}

module.exports = { planWorkBuddyToolDiscovery };
