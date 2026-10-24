'use strict';

const { randomBytes, createHash } = require('node:crypto');
const { types } = require('node:util');
const { createN09LifecycleClient } = require('./lifecycle-client-v2.js');
const { createDurableSnapshotReader } = require('../n09-snapshot/readonly-snapshot.js');
const { createBusinessClient } = require('../shared/business-client.js');
const { exact, snapshotOwnData } = require('../shared/boundary.js');
const { launchOptions } = require('../n09-ipc/lifecycle-channel.js');
const { isVerifiedNetworkProof } = require('../shared/hosted-probes.js');
const { performN09DurableCommand } = require('../n09-ack/durable-command.js');
const { parseStoredEvidenceSource } = require('../../../lib/proxy/context-evidence-stored-page');
const { parseObservedPage } = require('./observed-page');
const { seedReplyFailurePhase } = require('../shared/seed-reply-phase.js');
const fail = () => new Error('n09_business_adapter_failed');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const wire = (value) => Buffer.from(JSON.stringify(value));
const LIST = 'hpm_list_retained_evidence',
  READ = 'hpm_read_retained_evidence',
  ORIGINAL = 'n09_original';
const MODEL = 'n09-synthetic';
const user = (text) => ({ role: 'user', content: [{ type: 'input_text', text }] });
const originalTool = Object.freeze({
  type: 'function',
  name: ORIGINAL,
  description: 'Synthetic original',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
});
function textReply(id, text) {
  return {
    id,
    object: 'response',
    status: 'completed',
    model: MODEL,
    output: [
      {
        type: 'message',
        id: 'msg_' + id,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}
function parseReply(reply) {
  if (reply.status !== 200 || !Buffer.isBuffer(reply.bytes) || reply.bytes.length > 262144)
    throw fail();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(reply.bytes);
  const value = JSON.parse(text);
  if (value?.object !== 'response' || value.status !== 'completed' || !Array.isArray(value.output))
    throw fail();
  return value;
}
function publicText(reply) {
  if (
    reply.output.length !== 1 ||
    reply.output[0]?.type !== 'message' ||
    reply.output[0]?.role !== 'assistant' ||
    reply.output[0].content?.length !== 1 ||
    reply.output[0].content[0]?.type !== 'output_text' ||
    typeof reply.output[0].content[0].text !== 'string'
  )
    throw fail();
  return reply.output[0].content[0].text;
}
function resultFor(body, callId) {
  const rows = body.input.filter(
    (item) => item?.type === 'function_call_output' && item.call_id === callId
  );
  if (
    rows.length !== 1 ||
    typeof rows[0].output !== 'string' ||
    Buffer.byteLength(rows[0].output) > 131072
  )
    throw fail();
  return JSON.parse(rows[0].output);
}

// Construction is passive. The branded network proof and lazy lifecycle gate
// prevent a daemon or business request from preceding real hosted isolation.
function createN09BusinessAdapter(input, trusted = {}) {
  let options;
  try {
    options = launchOptions(input);
    trusted = snapshotOwnData(trusted);
    for (const [key, value] of Object.entries(trusted)) {
      if (
        ![
          'isVerifiedNetworkProof',
          'createLifecycle',
          'createBusinessClient',
          'createSnapshots',
          'spawn',
          'onPhase',
        ].includes(key) ||
        typeof value !== 'function' ||
        types.isProxy(value)
      )
        throw fail();
    }
  } catch {
    throw fail();
  }
  const nonce = randomBytes(16).toString('hex');
  const entryKey = randomBytes(24).toString('hex'),
    upstreamKey = randomBytes(24).toString('hex');
  const original = 'N09_PRIVATE_CONTENT ' + nonce + ' ' + 'synthetic-evidence '.repeat(256);
  const originalSha256 = sha(original);
  let proof,
    lifecycle,
    current,
    stoppedOwner,
    snapshots,
    seeded = false,
    closed = false,
    closeFailed = false,
    phase = 'idle';
  let continuation,
    summaryText,
    originalBaseline,
    readObserved = false,
    publicObserved = false;
  let source,
    privateRequests = 0,
    externalToolExecutions = 0,
    upstreamRequests = 0;
  let pendingSave;
  let upstreamFailurePhase;
  // Fixed progress classes for a 502 without a synthetic-upstream rejection.
  // 211 seed capture; 212 recovery before upstream; 213 after LIST dispatch;
  // 214 after READ dispatch; 215 after validated READ; 216 public dispatched.
  let recoveryProgressPhase = 212;
  let baselineSource;
  let validatedReadCount = 0,
    publicGenerationCount = 0,
    clearAckCount = 0,
    saveAckCount = 0,
    revokeAckCount = 0;
  const networkCheck = trusted.isVerifiedNetworkProof ?? isVerifiedNetworkProof;
  const onPhase = trusted.onPhase ?? (() => {});
  function gate(identity) {
    if (closed || !proof || !networkCheck(proof)) throw fail();
    if (identity) {
      identity = snapshotOwnData(identity);
      if (
        !current ||
        ['pid', 'configDir', 'runtimeDir', 'manifestSha256'].some(
          (key) => identity[key] !== current[key]
        )
      )
        throw fail();
    }
  }
  function client() {
    gate();
    if (!lifecycle)
      lifecycle = (trusted.createLifecycle ?? createN09LifecycleClient)(options, {
        ...(trusted.spawn ? { spawn: trusted.spawn } : {}),
        ...(trusted.onPhase ? { onPhase: trusted.onPhase } : {}),
      });
    return lifecycle;
  }
  const requestBody = (input, extra = {}) => ({
    model: MODEL,
    stream: false,
    instructions: 'Synthetic N09 owner ' + nonce,
    tools: [originalTool],
    tool_choice: 'auto',
    input,
    ...extra,
  });
  async function send(body) {
    gate(current);
    const bytes = wire(body);
    const client = (trusted.createBusinessClient ?? createBusinessClient)({
      entryPort: current.entryPort,
      entryKey,
      templates: { compact: bytes, continuation: bytes, ordinary: bytes },
    });
    return client('continuation');
  }
  function committed() {
    gate(current);
    if (!snapshots) throw fail();
    return snapshots.read();
  }
  function accounting(snapshot) {
    if (
      !originalBaseline ||
      snapshot.present !== true ||
      snapshot.rootId !== originalBaseline.rootId ||
      snapshot.expiresAt !== originalBaseline.expiresAt
    )
      throw fail();
    return {
      ...originalBaseline,
      calls: snapshot.calls,
      returnedBytes: snapshot.returnedBytes,
      revision: snapshot.revision,
    };
  }
  function reportRecoveryResponsePhase(response) {
    const failurePhase = seedReplyFailurePhase(response.status);
    if (failurePhase !== null) onPhase(failurePhase);
    if (failurePhase !== null && upstreamFailurePhase !== undefined) onPhase(upstreamFailurePhase);
    else if (response.status === 502) onPhase(recoveryProgressPhase);
  }
  function startSave() {
    if (pendingSave || phase !== 'ready') throw fail();
    phase = 'recovering';
    readObserved = false;
    publicObserved = false;
    source = undefined;
    upstreamFailurePhase = undefined;
    recoveryProgressPhase = 212;
    const tracked = { failed: false, completion: undefined };
    pendingSave = tracked;
    // Both handlers are installed immediately. Forced Job termination may reject
    // this HTTP request; that expected rejection must never escape unobserved.
    tracked.completion = send(continuation).then(
      (value) => {
        try {
          // The request can fail before any durable ACK is produced. Preserve
          // its finite HTTP/progress class rather than leaving only polling.
          reportRecoveryResponsePhase(value);
          if (
            publicText(parseReply(value)) !== 'N09_RECOVERY_OK ' + nonce ||
            !readObserved ||
            !publicObserved ||
            externalToolExecutions !== 1
          )
            throw fail();
        } catch {
          tracked.failed = true;
        }
      },
      () => {
        tracked.failed = true;
      }
    );
  }
  async function drainSave() {
    if (!pendingSave) return;
    await pendingSave.completion;
    pendingSave = undefined;
    if (!closed) phase = 'ready';
  }
  const api = {
    bindVerifiedNetworkProof(value) {
      if (closed || proof || lifecycle || !networkCheck(value)) throw fail();
      proof = value;
      return Object.freeze({ networkProofBound: true });
    },
    async startFreshBusinessHost() {
      gate();
      if (current || seeded) throw fail();
      onPhase(109);
      current = await client().startLifecycle();
      onPhase(110);
      const configured = await client().configureSyntheticBusiness(current, {
        entryKey,
        upstreamKey,
      });
      onPhase(111);
      if (configured.configured !== true) throw fail();
      return Object.freeze({
        ...current,
        actualBusinessHost: true,
        isolatedLoopbackSynthetic: true,
      });
    },
    async seedThroughBusinessHttp(identity) {
      gate(identity);
      if (seeded || phase !== 'idle') throw fail();
      const firstUser = user('N09_SEED ' + nonce);
      phase = 'seed-call';
      onPhase(131);
      const firstReply = await send(requestBody([firstUser]));
      onPhase(132);
      const first = parseReply(firstReply);
      if (
        first.output.length !== 1 ||
        first.output[0].type !== 'function_call' ||
        first.output[0].name !== ORIGINAL ||
        first.output[0].call_id !== 'n09_original_' + nonce ||
        first.output[0].arguments !== '{}'
      )
        throw fail();
      const history = [
        firstUser,
        first.output[0],
        { type: 'function_call_output', call_id: first.output[0].call_id, output: original },
      ];
      externalToolExecutions++;
      phase = 'seed-output';
      onPhase(133);
      const secondReply = await send(requestBody(history));
      onPhase(134);
      const secondFailurePhase = seedReplyFailurePhase(secondReply.status);
      if (secondFailurePhase !== null) onPhase(secondFailurePhase);
      if (secondReply.status === 502) onPhase(211);
      const second = parseReply(secondReply);
      if (publicText(second) !== 'N09_SEEDED ' + nonce) throw fail();
      history.push(...second.output);
      phase = 'summary';
      onPhase(135);
      const summaryReply = await send(
        requestBody(
          [
            ...history,
            user('CONTEXT CHECKPOINT COMPACTION ' + nonce + ' create a handoff summary'),
          ],
          { tools: [], tool_choice: 'auto' }
        )
      );
      onPhase(136);
      const summary = parseReply(summaryReply);
      summaryText = publicText(summary);
      if (
        !/<!-- hpm-codex-summary:hcr1_[a-f0-9]{48}_[a-f0-9]{64}_[1-9][0-9]{0,6} -->/.test(
          summaryText
        ) ||
        summaryText.includes(original)
      )
        throw fail();
      continuation = requestBody([user(summaryText), user('N09_RECOVER ' + nonce)]);
      onPhase(137);
      snapshots = (trusted.createSnapshots ?? createDurableSnapshotReader)(
        {
          ownedRoot: options.ownedRoot,
          runtimeDir: current.runtimeDir,
        },
        { onPhase }
      );
      const snapshot = committed();
      onPhase(138);
      if (
        snapshot.present !== true ||
        snapshot.evidenceLevel !== 'committed-metadata-only' ||
        snapshot.hostDurableAck !== false ||
        !Array.isArray(snapshot.capturedEvidence) ||
        snapshot.capturedEvidence.length !== 1 ||
        snapshot.capturedEvidence[0].capturedCallId !== 'n09_original_' + nonce
      )
        throw fail();
      baselineSource = parseStoredEvidenceSource(snapshot.capturedEvidence[0].source);
      if (
        baselineSource.digest !== originalSha256 ||
        baselineSource.toolName !== ORIGINAL ||
        baselineSource.argumentsDigest !== sha('{}') ||
        baselineSource.bytes !== Buffer.byteLength(original)
      )
        throw fail();
      originalBaseline = Object.freeze({
        originalSha256,
        authorizationSha256: sha(
          JSON.stringify([
            snapshot.rootId,
            snapshot.expiresAt,
            sha(summaryText),
            sha(entryKey),
            sha(upstreamKey),
            nonce,
          ])
        ),
        rootId: snapshot.rootId,
        expiresAt: snapshot.expiresAt,
        calls: snapshot.calls,
        returnedBytes: snapshot.returnedBytes,
      });
      seeded = true;
      phase = 'ready';
      return originalBaseline;
    },
    readCommittedSnapshot(identity) {
      gate(identity);
      return committed();
    },
    async killOwnedJob(identity) {
      gate(identity);
      const result = await client().stopLifecycle(current);
      stoppedOwner = undefined;
      if (
        result?.pid === current.pid &&
        result.treeEmpty === true &&
        result.shutdownInvoked === false &&
        result.semantics === 'forced_cleanup'
      )
        stoppedOwner = current;
      current = undefined;
      await drainSave();
      return result;
    },
    readCommittedSnapshotAfterKill(identity) {
      gate();
      identity = snapshotOwnData(identity);
      if (
        current ||
        !stoppedOwner ||
        !snapshots ||
        ['pid', 'configDir', 'runtimeDir', 'manifestSha256'].some(
          (key) => identity[key] !== stoppedOwner[key]
        )
      )
        throw fail();
      return snapshots.read();
    },
    async restartSameBusinessHost(previous) {
      gate();
      if (current || !seeded) throw fail();
      stoppedOwner = undefined;
      current = await client().restartLifecycle(previous);
      const ready = await client().attestSyntheticBusiness(current);
      if (ready.ready !== true || ready.syntheticBusinessConfigured !== true) throw fail();
      return Object.freeze({
        ...current,
        actualBusinessHost: true,
        isolatedLoopbackSynthetic: true,
      });
    },
    async readThroughBusinessHttp(identity) {
      gate(identity);
      if (!seeded || phase !== 'ready') throw fail();
      phase = 'recovering';
      readObserved = false;
      publicObserved = false;
      source = undefined;
      upstreamFailurePhase = undefined;
      recoveryProgressPhase = 212;
      const response = await send(continuation);
      reportRecoveryResponsePhase(response);
      if (response.status === 502 && upstreamFailurePhase === undefined) {
        if (typeof client().readRecoveryFailurePhase === 'function') {
          let failurePhase = 224;
          try {
            failurePhase = await client().readRecoveryFailurePhase(current);
          } catch {
            // Diagnostic failure cannot change the original HTTP failure.
          }
          onPhase(
            Number.isInteger(failurePhase) && failurePhase >= 217 && failurePhase <= 224
              ? failurePhase
              : 224
          );
        }
      }
      const reply = parseReply(response);
      if (
        publicText(reply) !== 'N09_RECOVERY_OK ' + nonce ||
        !readObserved ||
        !publicObserved ||
        externalToolExecutions !== 1
      )
        throw fail();
      const value = accounting(committed());
      phase = 'ready';
      return Object.freeze({
        exactRead: true,
        externalToolReplays: externalToolExecutions - 1,
        readOriginalSha256: originalSha256,
        authorizationSha256: value.authorizationSha256,
        accounting: value,
      });
    },
    getClearCapability(identity) {
      gate(identity);
      const clear = client().getClearCapability(current);
      return async () => {
        try {
          const value = await clear();
          if (
            value?.kind !== 'host-clear-completed' ||
            value.durableBoundary !== 'await-clearAsync'
          )
            throw fail();
          clearAckCount++;
          return value;
        } catch {
          throw fail();
        }
      };
    },
    existingHostDurableAckCapability(operation) {
      // Acquiring a capability is passive, even before proof binding/startup.
      if (closed || !['save', 'revoke'].includes(operation)) throw fail();
      return async (identity) => {
        try {
          gate(identity);
          if (!seeded || phase !== 'ready' || pendingSave) throw fail();
          const before = committed();
          // A completed snapshot is not evidence that ACK acquisition succeeded.
          // Keep the boundary visible without publishing root or revision data.
          onPhase(253);
          accounting(before);
          const host = client().getHostAckClient(current);
          let receiptPollingStarted = false;
          const receipt = await performN09DurableCommand(
            {
              pid: current.pid,
              operation,
              rootId: before.rootId,
              expiresAt: before.expiresAt,
              minRevision: before.revision,
            },
            {
              client: {
                submit: (value) => host.submit(value),
                readArmed: () => host.readArmed(),
                readReceipt: () => {
                  if (pendingSave?.failed) throw fail();
                  if (!receiptPollingStarted) {
                    receiptPollingStarted = true;
                    if (upstreamFailurePhase === undefined) onPhase(254);
                  }
                  return host.readReceipt();
                },
                close: () => host.close(),
              },
              startSave,
            }
          );
          // Snapshot is only a precondition. Final accounting comes from the
          // signed original-producer receipt; no post-ACK storage/management I/O.
          if (operation === 'save') saveAckCount++;
          else revokeAckCount++;
          return Object.freeze({
            kind: receipt.kind,
            durableBoundary: receipt.durableBoundary,
            pid: receipt.pid,
            accounting: {
              ...originalBaseline,
              calls: receipt.calls,
              returnedBytes: receipt.returnedBytes,
              revision: receipt.revision,
            },
          });
        } catch {
          throw fail();
        }
      };
    },
    async setCombinationThroughManagement(identity, combination) {
      gate(identity);
      return client().setCombination(current, combination);
    },
    async readOldReceiptThroughBusinessHttp(identity) {
      gate(identity);
      if (!seeded) throw fail();
      phase = 'denied';
      const before = privateRequests;
      const response = await send(continuation);
      const failurePhase = seedReplyFailurePhase(response.status);
      if (failurePhase !== null) onPhase(failurePhase);
      else onPhase(225);
      const reply = parseReply(response);
      onPhase(226);
      if (publicText(reply) !== 'N09_OLD_RECEIPT_DENIED ' + nonce) throw fail();
      onPhase(227);
      if (privateRequests !== before) throw fail();
      onPhase(228);
      if (externalToolExecutions !== 1) throw fail();
      onPhase(229);
      return Object.freeze({
        oldReceiptDenied: true,
        originalExposed: false,
        externalToolReplays: externalToolExecutions - 1,
      });
    },
    async onBusinessRequest(input) {
      let failurePhase = 196;
      try {
        gate();
        const incoming = exact(input, ['path', 'authorization', 'bytes', 'response']);
        if (
          incoming.path !== '/v1/responses' ||
          incoming.authorization !== 'Bearer ' + upstreamKey ||
          !Buffer.isBuffer(incoming.bytes) ||
          incoming.bytes.length > 262144
        )
          throw fail();
        const bodyText = new TextDecoder('utf-8', { fatal: true }).decode(incoming.bytes);
        const body = JSON.parse(bodyText);
        if (
          !Array.isArray(body.input) ||
          body.instructions !== 'Synthetic N09 owner ' + nonce ||
          body.model !== MODEL ||
          body.stream !== false
        )
          throw fail();
        upstreamRequests++;
        const privateTools =
          Array.isArray(body.tools) && body.tools.some((tool) => [LIST, READ].includes(tool?.name));
        if (privateTools) privateRequests++;
        const reply = (output) => {
          if (incoming.response.destroyed || incoming.response.headersSent) throw fail();
          if (!Number.isSafeInteger(upstreamRequests) || upstreamRequests < 1) throw fail();
          // Every synthetic model response is a distinct provider event. Stable
          // IDs across LIST/READ or later recovery rounds can incorrectly invoke
          // the real proxy's response association and replay defenses. Preserve
          // call_id for tool pairing; response and output-item identities vary.
          const suffix = '-' + upstreamRequests;
          const response = {
            ...output,
            id: output.id + suffix,
            output: output.output.map((item) => ({ ...item, id: item.id + suffix })),
          };
          incoming.response.writeHead(200, {
            'content-type': 'application/json',
            connection: 'close',
          });
          incoming.response.end(wire(response));
        };
        const call = (name, args, callId) => ({
          ...textReply('n09-private-' + nonce, ''),
          output: [
            {
              type: 'function_call',
              id: 'fc_' + callId,
              call_id: callId,
              name,
              arguments: JSON.stringify(args),
            },
          ],
        });
        if (phase === 'seed-call') {
          if (privateTools) throw fail();
          phase = 'seed-call-seen';
          return reply(call(ORIGINAL, {}, 'n09_original_' + nonce));
        }
        if (phase === 'seed-output') {
          const tool = body.input.filter(
            (item) =>
              item?.type === 'function_call_output' && item.call_id === 'n09_original_' + nonce
          );
          if (tool.length !== 1 || tool[0].output !== original) throw fail();
          return reply(textReply('n09-seeded-' + nonce, 'N09_SEEDED ' + nonce));
        }
        if (phase === 'summary')
          return reply(
            textReply(
              'n09-summary-' + nonce,
              'Retain the original evidence pointer for owner ' + nonce + '.'
            )
          );
        if (phase === 'denied') {
          if (privateTools || bodyText.includes(original)) throw fail();
          return reply(textReply('n09-denied-' + nonce, 'N09_OLD_RECEIPT_DENIED ' + nonce));
        }
        if (phase !== 'recovering') throw fail();
        const listId = 'n09_list_' + nonce,
          readId = 'n09_read_' + nonce;
        if (privateTools && !body.input.some((item) => item?.call_id === listId)) {
          recoveryProgressPhase = 213;
          return reply(call(LIST, { limit: 1 }, listId));
        }
        failurePhase = 197;
        if (privateTools && !body.input.some((item) => item?.call_id === readId)) {
          const index = resultFor(body, listId);
          if (index.ok !== true || !Array.isArray(index.sources) || index.sources.length !== 1)
            throw fail();
          source = parseStoredEvidenceSource(index.sources[0]);
          if (
            !/^hce_[a-f0-9]{32}$/.test(source?.sourceId) ||
            source.digest !== originalSha256 ||
            source.toolName !== ORIGINAL ||
            source.argumentsDigest !== sha('{}') ||
            source.bytes !== Buffer.byteLength(original) ||
            !originalBaseline ||
            !baselineSource ||
            Object.keys(baselineSource).some((key) => source[key] !== baselineSource[key])
          )
            throw fail();
          recoveryProgressPhase = 214;
          return reply(
            call(
              READ,
              {
                sourceId: source.sourceId,
                digest: source.digest,
                offsetBytes: 0,
                limitBytes: 8192,
              },
              readId
            )
          );
        }
        failurePhase = 198;
        if (privateTools) {
          failurePhase = 201;
          const result = resultFor(body, readId);
          if (result?.ok !== true) {
            const reason = result?.error ?? result?.code;
            failurePhase = [
              'context_evidence_unavailable',
              'context_recovery_storage_unavailable',
            ].includes(reason)
              ? 206
              : ['context_artifact_budget_exceeded', 'evidence_read_budget_exceeded'].includes(
                    reason
                  )
                ? 207
                : reason === 'context_artifact_invalid_range'
                  ? 208
                  : 209;
            throw fail();
          }
          failurePhase = 203;
          const read = parseObservedPage(result, source, {
              offsetBytes: 0,
              limitBytes: 8192,
            }),
            page = read.page;
          failurePhase = 204;
          if (
            read.ok !== true ||
            !source ||
            read.source?.sourceId !== source.sourceId ||
            read.source?.digest !== originalSha256 ||
            typeof page?.text !== 'string' ||
            page.digest !== originalSha256
          )
            throw fail();
          failurePhase = 205;
          if (
            page.offsetBytes !== 0 ||
            page.endOffsetBytes !== Buffer.byteLength(original) ||
            page.totalBytes !== Buffer.byteLength(original) ||
            page.nextOffsetBytes !== null
          )
            throw fail();
          failurePhase = 204;
          if (sha(page.text) !== originalSha256) throw fail();
          readObserved = true;
          validatedReadCount++;
          recoveryProgressPhase = 215;
          return reply(textReply('n09-private-done-' + nonce, 'RECOVERED'));
        }
        // Keep the first-read class, but distinguish the ACK-triggered request
        // from a later same-owner recovery. Counters are local synthetic proof.
        failurePhase = pendingSave ? 251 : validatedReadCount > 0 ? 252 : 230;
        if (!readObserved) throw fail();
        failurePhase = 231;
        if (!bodyText.includes(original)) throw fail();
        publicObserved = true;
        publicGenerationCount++;
        recoveryProgressPhase = 216;
        return reply(textReply('n09-public-' + nonce, 'N09_RECOVERY_OK ' + nonce));
      } catch {
        // Only this finite local boundary code survives a synthetic upstream
        // socket refusal. Never retain the exception, request or tool output.
        upstreamFailurePhase = failurePhase;
        onPhase(failurePhase);
        throw fail();
      }
    },
    inspectBusinessEvidence() {
      if (!proof || !networkCheck(proof)) throw fail();
      return Object.freeze({
        seeded,
        validatedReadCount,
        publicGenerationCount,
        clearAckCount,
        saveAckCount,
        revokeAckCount,
        upstreamRequests,
        privateRequests,
        externalToolExecutions,
        ...(originalBaseline
          ? {
              originalSha256,
              authorizationSha256: originalBaseline.authorizationSha256,
              rootId: originalBaseline.rootId,
              expiresAt: originalBaseline.expiresAt,
            }
          : {}),
      });
    },
    async close() {
      if (closed) {
        if (closeFailed) throw fail();
        return;
      }
      closed = true;
      phase = 'closed';
      let failed = false;
      try {
        snapshots?.close();
      } catch {
        failed = true;
      }
      try {
        if (lifecycle) await lifecycle.close();
      } catch {
        failed = true;
      }
      try {
        await drainSave();
      } catch {
        failed = true;
      }
      current = undefined;
      continuation = undefined;
      summaryText = undefined;
      source = undefined;
      closeFailed = failed;
      if (failed) throw fail();
    },
  };
  // Sanitize every boundary including sync parser failures and async handler errors.
  return Object.freeze(
    Object.fromEntries(
      Object.entries(api).map(([name, operation]) => [
        name,
        (...args) => {
          try {
            const result = operation(...args);
            return result && typeof result.then === 'function'
              ? result.catch(() => {
                  throw fail();
                })
              : result;
          } catch {
            throw fail();
          }
        },
      ])
    )
  );
}
module.exports = { createN09BusinessAdapter };
