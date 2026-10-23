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
const {
  parseStoredEvidenceSource,
  parseStoredEvidencePage,
} = require('../../../lib/proxy/context-evidence-stored-page');
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
    return { ...originalBaseline, calls: snapshot.calls, returnedBytes: snapshot.returnedBytes };
  }
  function startSave() {
    if (pendingSave || phase !== 'ready') throw fail();
    phase = 'recovering';
    readObserved = false;
    publicObserved = false;
    source = undefined;
    const tracked = { failed: false, completion: undefined };
    pendingSave = tracked;
    // Both handlers are installed immediately. Forced Job termination may reject
    // this HTTP request; that expected rejection must never escape unobserved.
    tracked.completion = send(continuation).then(
      (value) => {
        try {
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
        snapshot.hostDurableAck !== false
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
      current = undefined;
      await drainSave();
      return result;
    },
    async restartSameBusinessHost(previous) {
      gate();
      if (current || !seeded) throw fail();
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
      const reply = parseReply(await send(continuation));
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
          accounting(before);
          const host = client().getHostAckClient(current);
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
      const reply = parseReply(await send(continuation));
      if (
        publicText(reply) !== 'N09_OLD_RECEIPT_DENIED ' + nonce ||
        privateRequests !== before ||
        externalToolExecutions !== 1
      )
        throw fail();
      return Object.freeze({
        oldReceiptDenied: true,
        originalExposed: false,
        externalToolReplays: externalToolExecutions - 1,
      });
    },
    async onBusinessRequest(input) {
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
        incoming.response.writeHead(200, {
          'content-type': 'application/json',
          connection: 'close',
        });
        incoming.response.end(wire(output));
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
      if (privateTools && !body.input.some((item) => item?.call_id === listId))
        return reply(call(LIST, { limit: 1 }, listId));
      if (privateTools && !body.input.some((item) => item?.call_id === readId)) {
        const index = resultFor(body, listId);
        if (index.ok !== true || !Array.isArray(index.sources) || index.sources.length !== 1)
          throw fail();
        source = parseStoredEvidenceSource(index.sources[0]);
        if (
          !/^hce_[a-f0-9]{32}$/.test(source?.sourceId) ||
          source.digest !== originalSha256 ||
          source.toolName !== ORIGINAL ||
          source.callId !== 'n09_original_' + nonce ||
          source.argumentsDigest !== sha('{}') ||
          source.bytes !== Buffer.byteLength(original) ||
          !originalBaseline ||
          source.expiresAt > originalBaseline.expiresAt
        )
          throw fail();
        return reply(
          call(
            READ,
            { sourceId: source.sourceId, digest: source.digest, offsetBytes: 0, limitBytes: 8192 },
            readId
          )
        );
      }
      if (privateTools) {
        const read = parseStoredEvidencePage(resultFor(body, readId), source, {
            offsetBytes: 0,
            limitBytes: 8192,
          }),
          page = read.page;
        if (
          read.ok !== true ||
          !source ||
          read.source?.sourceId !== source.sourceId ||
          read.source?.digest !== originalSha256 ||
          typeof page?.text !== 'string' ||
          sha(page.text) !== originalSha256 ||
          page.digest !== originalSha256 ||
          page.offsetBytes !== 0 ||
          page.endOffsetBytes !== Buffer.byteLength(original) ||
          page.totalBytes !== Buffer.byteLength(original) ||
          page.nextOffsetBytes !== null
        )
          throw fail();
        readObserved = true;
        validatedReadCount++;
        return reply(textReply('n09-private-done-' + nonce, 'RECOVERED'));
      }
      if (!readObserved || !bodyText.includes(original)) throw fail();
      publicObserved = true;
      publicGenerationCount++;
      return reply(textReply('n09-public-' + nonce, 'N09_RECOVERY_OK ' + nonce));
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
