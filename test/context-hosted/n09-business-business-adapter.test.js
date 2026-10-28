'use strict';
// Pure protocol emulator: no sockets, process, SQLite, DPAPI or model request.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const {
  createN09BusinessAdapter,
} = require('../../scripts/context-hosted/n09-business/business-adapter.js');
const {
  runCommittedObservedKill,
} = require('../../scripts/context-hosted/n09-snapshot/committed-observed-driver.js');
const {
  runPreparedPublicationCommit,
} = require('../../scripts/context-hosted/n09-business/publication-commit-driver');
const {
  runClearAfterAck,
  runDurableSaveOrRevokeAfterAck,
  runBackupRollbackAfterRevoke,
  runUnpublishedResponseKill,
} = require('../../scripts/context-hosted/n09-ipc/driver.js');
const {
  runPreparedPublicationAck,
} = require('../../scripts/context-hosted/n09-business/publication-ack-driver');
const {
  runTransitionPublicationCommit,
} = require('../../scripts/context-hosted/n09-business/publication-transition-commit-driver');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const bad = { message: 'n09_business_adapter_failed' };
function fixture(mutation = () => {}, onPhase, prepared = false) {
  const ownedRoot = path.join(os.tmpdir(), 'n09-business-pure');
  const options = {
    ownedRoot,
    install: path.join(ownedRoot, 'payload'),
    manifestSha256: 'a'.repeat(64),
  };
  const proof = Object.freeze({ pure: true });
  const state = {
    pid: 101,
    configured: 0,
    created: 0,
    stopped: 0,
    closed: 0,
    sent: 0,
    nativeReadObserved: 0,
    rootId: 'hbs_' + 'b'.repeat(32),
    expiresAt: 10000,
    calls: 0,
    returnedBytes: 0,
    revision: 1,
    cleared: false,
    events: [],
    config: undefined,
    original: undefined,
  };
  const identity = () => ({
    pid: state.pid,
    manifestSha256: options.manifestSha256,
    entryPort: 12346,
    configDir: path.join(ownedRoot, 'config'),
    runtimeDir: path.join(ownedRoot, 'runtime'),
  });
  const sourceReceipt = () => ({
    sourceId: 'hce_' + 'c'.repeat(32),
    digest: sha(state.original),
    bytes: Buffer.byteLength(state.original),
    callId: 'hpa_' + sha('synthetic-capture-snapshot\0' + state.originalCallId),
    toolName: 'n09_original',
    argumentsDigest: sha('{}'),
    expiresAt: state.expiresAt + 1,
    trust: 'tool_data_not_instructions',
  });
  const trusted = {
    isVerifiedNetworkProof: (value) => value === proof,
    createLifecycle: () => {
      state.created++;
      return {
        startLifecycle: async () => identity(),
        configureSyntheticBusiness: async (_identity, config) => {
          state.config = config;
          state.configured++;
          return { configured: true };
        },
        attestSyntheticBusiness: async () => ({ ready: true, syntheticBusinessConfigured: true }),
        getRecoveryCompletionBarrier: async () => {
          state.events.push('completion-baseline');
          return async () => {
            state.events.push('publication-completed');
            const value = { completed: true, hostDurableAck: false };
            await mutation('publication-completed', value, state);
            return value;
          };
        },
        getRecoveryCancellationBarrier: async () => {
          state.events.push('cancellation-baseline');
          return async () => {
            const value = { cancelled: true, cleanupFinished: true, hostDurableAck: false };
            state.events.push('cancellation-completed');
            await mutation('cancellation-completed', value, state);
            return value;
          };
        },
        attestRejectedPersistentStorage: async () => {
          const value = { persistentStorageRejected: true, syntheticBusinessConfigured: true };
          mutation('rejected-storage', value, state);
          state.storageRejected = true;
          state.events.push('rejected-storage');
          return value;
        },
        ...(state.diagnostic === undefined ? {} : { readRecoveryFailurePhase: state.diagnostic }),
        ...(state.admissionDiagnostic === undefined
          ? {}
          : { readRecoveryAdmissionFailurePhase: state.admissionDiagnostic }),
        stopLifecycle: async (owner) => {
          state.events.push('kill');
          state.ackProbeActive = false;
          state.ackQueued = false;
          state.commitQueued = false;
          state.interruptObserved?.(state.interruptionReason ?? 'transport-error');
          state.rejectPending?.(new Error('synthetic_forced_kill'));
          state.ackCommand = undefined;
          state.stopped++;
          return {
            pid: owner.pid,
            treeEmpty: true,
            shutdownInvoked: false,
            semantics: 'forced_cleanup',
          };
        },
        restartLifecycle: async () => {
          state.pid++;
          return identity();
        },
        getClearCapability: () => async () => {
          state.cleared = true;
          return { kind: 'host-clear-completed', durableBoundary: 'await-clearAsync' };
        },
        getHostAckClient: () => ({
          submit(command) {
            mutation('ack-submit', command, state);
            state.events.push('submit');
            state.ackCommand = command;
            if (command.operation === 'revoke-bound-root') state.cleared = true;
          },
          readArmed() {
            mutation('ack-armed', undefined, state);
            state.events.push('armed');
            return true;
          },
          readReceipt() {
            mutation('ack-receipt', undefined, state);
            const command = state.ackCommand;
            if (command.operation === 'arm-save' && state.revision <= command.minRevision)
              return null;
            const saving = command.operation === 'arm-save';
            const receipt = {
              version: 1,
              pid: state.pid,
              epoch: 'f'.repeat(32),
              sequence: 1,
              kind: saving ? 'host-save-completed' : 'host-revoke-completed',
              durableBoundary: saving ? 'await-reference-save' : 'await-revokeAsync',
              rootId: state.rootId,
              expiresAt: state.expiresAt,
              revision: state.revision,
              calls: state.calls,
              returnedBytes: state.returnedBytes,
              revisionSource: 'validated-reference-save',
              evidenceLevel: 'observer-boundary-only',
              liveDaemonProved: false,
            };
            mutation('ack', receipt, state);
            state.events.push('ack');
            return receipt;
          },
          close() {},
        }),
        getPublicationAckClient: () => {
          const signal = (kind) => {
            const held = !['armed', 'armed-cancel'].includes(kind);
            const delta = ['sending', 'withdrawn'].includes(state.ackTarget.transition)
              ? 2
              : ['transport-finished', 'uncertain'].includes(state.ackTarget.transition)
                ? 3
                : 1;
            const value = {
              version: 1,
              pid: state.pid,
              epoch: 'e'.repeat(32),
              challenge: 'f'.repeat(32),
              ...state.ackTarget,
              kind,
              callOrdinal: held ? delta + (kind === 'trigger-held' ? 0 : 1) : 1,
              holdChallenge: held ? (kind === 'trigger-held' ? 'b' : 'a').repeat(32) : '',
              revision:
                state.ackTarget.expectedRevision + (held && kind !== 'trigger-held' ? 1 : 0),
            };
            mutation('prepared-ack-' + kind, value, state);
            return value;
          };
          return {
            async armCancellation(target) {
              state.ackProbeActive = true;
              state.ackTarget = target;
              state.events.push('ack-arm-cancel');
              return signal('armed-cancel');
            },
            async waitTriggerHeld() {
              for (let i = 0; i < 50 && !state.triggerQueued; i++)
                await new Promise((resolve) => setImmediate(resolve));
              assert.equal(state.triggerQueued, true);
              state.events.push('ack-trigger-held');
              return signal('trigger-held');
            },
            releaseTrigger() {
              state.events.push('ack-trigger-release');
              assert.equal(state.observedHttp.reason, 'cancelled-transport');
              state.resolveTrigger();
            },
            async arm(target) {
              state.ackProbeActive = true;
              state.ackTarget = target;
              state.events.push('ack-arm');
              return signal('armed');
            },
            async waitHeld() {
              for (let i = 0; i < 50 && !state.ackQueued; i++)
                await new Promise((resolve) => setImmediate(resolve));
              assert.equal(state.ackQueued, true);
              state.events.push('ack-held');
              return signal('held');
            },
            release() {
              state.ackProbeActive = false;
              state.events.push('ack-release');
              state.resolveAck();
            },
            async waitReleased() {
              return signal('released');
            },
            close() {
              state.ackProbeActive = false;
              state.events.push('ack-close');
            },
          };
        },
        getPublicationObservationClient: () => ({
          async query() {
            const pending = state.commitQueued === true;
            const target = state.ackTarget?.transition;
            const delta = ['sending', 'withdrawn'].includes(target)
              ? 2
              : ['transport-finished', 'uncertain'].includes(target)
                ? 3
                : 1;
            const ordinal = state.ackQueued ? delta + 1 : state.triggerQueued ? delta : 1;
            const value = {
              generation: 1,
              callOrdinal: pending ? ordinal + 1 : ordinal,
              activeCount: pending ? 1 : 0,
              status: pending ? 'pending' : 'completed',
              operation: 'save-reference-state',
              transition: pending ? (state.commitTarget ?? 'prepared') : 'none',
              rootId: state.rootId,
              expiresAt: state.expiresAt,
              expectedRevision: state.revision,
            };
            mutation('publication-query', value, state);
            return value;
          },
        }),
        setCombination: async () => ({ savedConfigVerified: true }),
        close: async () => {
          state.interruptObserved?.('cancelled');
          state.rejectPending?.(new Error('synthetic_owner_close'));
          state.closed++;
        },
      };
    },
    createSnapshots: () => ({
      read: () => {
        state.events.push('snapshot');
        mutation('snapshot', undefined, state);
        return {
          present: true,
          evidenceLevel: 'committed-metadata-only',
          hostDurableAck: false,
          rootId: state.rootId,
          expiresAt: state.expiresAt,
          calls: state.calls,
          returnedBytes: state.returnedBytes,
          revision: state.revision,
          capturedEvidence: state.original
            ? [{ capturedCallId: state.originalCallId, source: sourceReceipt() }]
            : [],
        };
      },
      close() {},
    }),
    createBackup: (_input, assertStopped) => ({
      capture() {
        assert.equal(assertStopped(), true);
        state.events.push('backup-capture');
        const value = { encryptedFilesCaptured: 2, independentAnchorCaptured: false };
        mutation('backup-capture', value, state);
        return value;
      },
      restore() {
        assert.equal(assertStopped(), true);
        state.events.push('backup-restore');
        state.cleared = false;
        const value = { encryptedFilesRestored: 2, independentAnchorRestored: false };
        mutation('backup-restore', value, state);
        return value;
      },
      close() {
        state.backupClosed = true;
      },
    }),
    createBusinessClient: (input) => async () => {
      state.sent++;
      if (state.storageRejected) {
        const body = {
          error: {
            type: 'service_unavailable',
            code: 'context_recovery_unavailable',
            message: 'Context recovery is temporarily unavailable.',
          },
        };
        mutation('rejected-reply', body, state);
        return { status: state.rejectedStatus ?? 503, bytes: Buffer.from(JSON.stringify(body)) };
      }
      const body = JSON.parse(input.templates.continuation);
      const native = async (request) => {
        let result;
        const response = {
          destroyed: false,
          headersSent: false,
          writeHead(status) {
            assert.equal(status, 200);
            this.headersSent = true;
          },
          end(bytes) {
            result = JSON.parse(bytes);
            state.resolveHeldReply?.();
          },
          destroy() {
            this.destroyed = true;
            state.destroyedHeldResponses = (state.destroyedHeldResponses ?? 0) + 1;
          },
        };
        const incoming = {
          path: '/v1/responses',
          authorization: 'Bearer ' + state.config.upstreamKey,
          bytes: Buffer.from(JSON.stringify(request)),
          response,
        };
        mutation('upstream', incoming, state);
        await adapter.onBusinessRequest(incoming);
        if (result === undefined && state.observedHttp) {
          state.events.push('public-response-held');
          if (state.observedHttp.reason !== 'pending') throw Error('synthetic_already_interrupted');
          await new Promise((resolve, reject) => {
            state.resolveHeldReply = resolve;
            state.rejectPending = reject;
          });
        }
        assert.ok(result);
        mutation('native-reply', result, state);
        return result;
      };
      let result;
      const isContinuation =
        body.input[0]?.role === 'user' &&
        body.input[0].content?.[0]?.text?.includes('hpm-codex-summary:');
      if (isContinuation && !state.cleared) {
        const refusal = () => ({ status: 502, bytes: Buffer.from('{}') });
        if (state.refuseAfter === 0) return refusal();
        const tools = [
          { type: 'function', name: 'hpm_list_retained_evidence' },
          { type: 'function', name: 'hpm_read_retained_evidence' },
        ];
        let request = { ...body, tools };
        result = await native(request);
        if (state.refuseAfter === 1) return refusal();
        assert.equal(result.output[0].name, 'hpm_list_retained_evidence');
        const source = sourceReceipt();
        request = {
          ...request,
          input: [
            ...request.input,
            result.output[0],
            {
              type: 'function_call_output',
              call_id: result.output[0].call_id,
              output: JSON.stringify({ ok: true, sources: [source] }),
            },
          ],
        };
        mutation('list', source, state);
        // Apply list mutation to the actual serialized result, too.
        request.input.at(-1).output = JSON.stringify({ ok: true, sources: [source] });
        result = await native(request);
        if (state.refuseAfter === 2) return refusal();
        assert.equal(result.output[0].name, 'hpm_read_retained_evidence');
        const page = {
          text: state.original,
          encoding: 'utf8',
          offsetBytes: 0,
          endOffsetBytes: source.bytes,
          nextOffsetBytes: null,
          totalBytes: source.bytes,
          digest: source.digest,
          chunkDigest: source.digest,
        };
        const read = {
          ok: true,
          source,
          page,
          observation: 'client_reported',
          verification: 'not_verified',
        };
        mutation('read', read, state);
        request = {
          ...request,
          input: [
            ...request.input,
            result.output[0],
            {
              type: 'function_call_output',
              call_id: result.output[0].call_id,
              output: JSON.stringify(read),
            },
          ],
        };
        result = await native(request);
        if (state.refuseAfter === 3) return refusal();
        state.nativeReadObserved++;
        assert.equal(result.output[0].type, 'message');
        const publicBody = {
          ...body,
          tools: [],
          input: [
            ...body.input,
            { role: 'user', content: [{ type: 'input_text', text: state.original }] },
          ],
        };
        mutation('public', publicBody, state);
        // The held observer has already completed private reads before the
        // public upstream response. Persist its synthetic accounting now.
        if (state.observedHttp?.reason === 'pending') {
          state.calls += 2;
          state.returnedBytes += source.bytes;
          state.revision++;
        }
        result = await native(publicBody);
        if (state.ackProbeActive) {
          const terminal = ['withdrawn', 'uncertain'].includes(state.ackTarget.transition);
          const delta = ['sending', 'withdrawn'].includes(state.ackTarget.transition)
            ? 2
            : ['transport-finished', 'uncertain'].includes(state.ackTarget.transition)
              ? 3
              : 1;
          state.revision += delta - (terminal ? 1 : 0);
          if (terminal) {
            state.triggerQueued = true;
            await new Promise((resolve) => {
              state.resolveTrigger = resolve;
            });
            if (state.commitWitnessActive) {
              state.commitQueued = true;
              await new Promise((resolve, reject) => {
                state.resolveCommit = resolve;
                state.rejectPending = reject;
              });
            } else state.revision++;
          }
          state.ackQueued = true;
          if (state.ackTarget.transition === 'transport-finished') {
            const bytes = Buffer.from(JSON.stringify(result));
            state.observedHttp.bytes = bytes.length;
            state.events.push('public-wire-before-ack');
            state.publicWireResponse = { status: 200, bytes };
            state.interruptObserved('response', { response: state.publicWireResponse });
          }
          await new Promise((resolve, reject) => {
            state.resolveAck = resolve;
            state.rejectPending = reject;
          });
        }
        if (state.commitWitnessActive) {
          state.commitQueued = true;
          if (state.commitTarget === 'transport-finished') {
            const bytes = Buffer.from(JSON.stringify(result));
            state.observedHttp.bytes = bytes.length;
            state.publicWireResponse = { status: 200, bytes };
            state.events.push('public-wire-before-commit');
            state.interruptObserved('response', { response: state.publicWireResponse });
          }
          await new Promise((resolve, reject) => {
            state.resolveCommit = resolve;
            state.rejectPending = reject;
          });
        }
        if (state.refuseAfter === 4) return refusal();
        if (
          (!state.observedHttp || state.observedHttp.reason !== 'pending') &&
          !(
            ['transport-finished', 'withdrawn', 'uncertain'].includes(
              state.ackTarget?.transition
            ) && state.ackQueued
          ) &&
          !(state.commitTarget === 'transport-finished' && state.commitQueued)
        ) {
          state.calls += 2;
          state.returnedBytes += source.bytes;
          state.revision++;
        }
      } else {
        const output = body.input.find((item) => item.type === 'function_call_output');
        if (output) {
          state.original = output.output;
          state.originalCallId = output.call_id;
        }
        result = await native(body);
        if (body.tools.length === 0 && !isContinuation) {
          result.output[0].content[0].text +=
            '\n<!-- hpm-codex-summary:hcr1_' + 'd'.repeat(48) + '_' + 'e'.repeat(64) + '_1 -->';
        }
      }
      mutation('reply', result, state);
      if (state.ackCommand?.operation === 'arm-save' && state.holdSave) {
        state.events.push('http-pending');
        await new Promise((_resolve, reject) => {
          state.rejectPending = reject;
        });
      }
      return { status: state.replyStatus ?? 200, bytes: Buffer.from(JSON.stringify(result)) };
    },
  };
  const originalBusinessClient = trusted.createBusinessClient;
  trusted.createBusinessClient = (input) => async () => {
    try {
      return await originalBusinessClient(input)();
    } catch (error) {
      if (!state.returnHttpFailure) throw error;
      return { status: 502, bytes: Buffer.from('{}') };
    }
  };
  trusted.startObservedContinuation = (input) => {
    let resolve;
    const result = new Promise((done) => {
      resolve = done;
    });
    const observation = { reason: 'pending', bytes: 0, cancellations: 0 };
    state.observedHttp = observation;
    const finish = (reason, value = { failed: true }) => {
      if (observation.reason !== 'pending') return;
      observation.reason = reason;
      resolve(value);
    };
    state.interruptObserved = finish;
    void trusted
      .createBusinessClient({
        entryPort: input.entryPort,
        templates: { continuation: input.body },
      })()
      .then(
        (response) => {
          if (observation.reason !== 'pending') return;
          observation.bytes = response.bytes.length;
          finish('response', { response });
        },
        () => finish('transport-error')
      );
    const observer = {
      result,
      bytes: () => observation.bytes,
      termination: () => observation.reason,
      cancel() {
        observation.cancellations++;
        const terminal = ['withdrawn', 'uncertain'].includes(state.ackTarget?.transition);
        finish(terminal ? 'cancelled-transport' : 'cancelled');
        if (!terminal) state.rejectPending?.(new Error('synthetic_client_cancelled'));
        return true;
      },
    };
    mutation('observed-client', observation, state);
    return observer;
  };
  if (prepared === true || prepared === 'ack-commit')
    trusted.createCommitWitness = (input) => {
      mutation('commit-create', input, state);
      state.commitWitnessActive = true;
      const prefix = state.ackTarget?.transition;
      state.commitTarget =
        prefix === 'prepared'
          ? 'sending'
          : prefix === 'sending'
            ? 'transport-finished'
            : ['withdrawn', 'uncertain'].includes(prefix)
              ? prefix
              : 'prepared';
      return {
        async waitPending() {
          for (let i = 0; i < 50 && !state.commitQueued; i++)
            await new Promise((resolve) => setImmediate(resolve));
          assert.equal(state.commitQueued, true);
          return {
            readAdmissionBlocked: true,
            evidenceLevel: 'sqlite-read-admission-only',
            publicationQualified: false,
          };
        },
        release() {
          state.commitWitnessActive = false;
          if (state.commitQueued && state.stopped === 0) {
            state.revision++;
            state.resolveCommit();
          }
          state.events.push('commit-release');
          const value = { released: true };
          mutation('commit-release', value, state);
          return value;
        },
        close() {
          state.commitWitnessActive = false;
          state.events.push('commit-close');
        },
      };
    };
  const adapter = createN09BusinessAdapter(options, {
    ...trusted,
    ...(onPhase ? { onPhase } : {}),
  });
  return { adapter, options, proof, state, trusted };
}
test('prepared COMMIT orchestration drives actual adapter hold, query, forced kill and release control paths', async () => {
  for (const kill of [true, false]) {
    const f = fixture(() => {}, undefined, true);
    f.adapter.bindVerifiedNetworkProof(f.proof);
    const receipt = await runPreparedPublicationCommit(f.adapter, kill);
    assert.equal(receipt.forcedKill, kill);
    assert.equal(receipt.originalReadAfterRestart, true);
    assert.equal(receipt.positivePublicCompletion, !kill);
    const evidence = f.adapter.inspectBusinessEvidence();
    assert.equal(evidence.validatedReadCount, 3);
    assert.equal(evidence.publicGenerationCount, 3);
    assert.equal(f.state.events.includes('commit-release'), true);
    assert.equal(f.state.closed, 1);
  }
});
test('held independent public response is interrupted before bytes, then exact recovery preserves read accounting', async () => {
  const f = fixture();
  f.adapter.bindVerifiedNetworkProof(f.proof);
  const receipt = await runUnpublishedResponseKill(f.adapter);
  assert.equal(receipt.boundary, 'upstream-public-final-held');
  assert.equal(receipt.interruptedWithZeroPublicBytes, true);
  assert.equal(receipt.originalReadAfterRestart, true);
  assert.equal(receipt.sameDirectoryNewPid, true);
  assert.equal(receipt.commitInProgressQualified, false);
  assert.equal(receipt.publicationCommitQualified, false);
  assert.equal(receipt.n09Complete, false);
  assert.equal(f.state.nativeReadObserved, 3);
  assert.equal(f.state.calls, 6);
  assert.equal(f.state.returnedBytes, Buffer.byteLength(f.state.original) * 3);
  const evidence = f.adapter.inspectBusinessEvidence();
  assert.equal(evidence.validatedReadCount, 3);
  assert.equal(evidence.publicGenerationCount, 2);
  assert.equal(evidence.externalToolExecutions, 1);
  assert.equal(f.state.stopped, 2);
  assert.equal(f.state.closed, 1);
  assert.equal(f.state.observedHttp.cancellations, 1);
  assert.equal(f.state.destroyedHeldResponses, 1);
});

test('held-response driver rejects false interruption evidence, restart identity and rolled-back accounting', async () => {
  for (const [method, change] of [
    ['beginPublicResponseHold', { pid: 999 }],
    ['beginPublicResponseHold', { publicBytes: 1 }],
    ['beginPublicResponseHold', { exactRead: false }],
    ['beginPublicResponseHold', { externalToolReplays: 1 }],
    ['finishInterruptedPublicResponse', { interrupted: false }],
    ['finishInterruptedPublicResponse', { publicBytes: 1 }],
    ['readCommittedSnapshotAfterKill', { calls: 0 }],
    ['readCommittedSnapshotAfterKill', { returnedBytes: 0, revision: 1 }],
    ['restartSameBusinessHost', { pid: 101 }],
    ['restartSameBusinessHost', { configDir: path.join(os.tmpdir(), 'wrong-config') }],
  ]) {
    const f = fixture();
    f.adapter.bindVerifiedNetworkProof(f.proof);
    const original = f.adapter[method];
    const wrapped = {
      ...f.adapter,
      [method]:
        method === 'readCommittedSnapshotAfterKill'
          ? (...args) => ({ ...original(...args), ...change })
          : async (...args) => ({ ...(await original(...args)), ...change }),
    };
    await assert.rejects(runUnpublishedResponseKill(wrapped), { message: 'n09_ack_kill_failed' });
    assert.equal(f.state.closed, 1);
    assert.equal(f.state.observedHttp.cancellations, 1);
    assert.ok(f.state.stopped >= 1);
  }
});

test('held-response path cannot classify timeout, cancellation or emitted bytes as forced transport loss', async () => {
  for (const reason of ['timeout', 'cancelled', 'setup-error', 'response']) {
    const f = fixture();
    f.state.interruptionReason = reason;
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runUnpublishedResponseKill(f.adapter), { message: 'n09_ack_kill_failed' });
    assert.equal(f.state.closed, 1);
    assert.equal(f.state.stopped, 1);
  }
  const f = fixture((at, observation) => {
    if (at === 'observed-client') observation.bytes = 1;
  });
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await assert.rejects(runUnpublishedResponseKill(f.adapter), { message: 'n09_ack_kill_failed' });
  assert.equal(f.state.closed, 1);
  assert.equal(f.state.stopped, 1);
});

test('unpublished-restart-revision must preserve the stopped durable revision as well as counters', async () => {
  for (const revision of [undefined, 0, 1, NaN, Infinity]) {
    const f = fixture();
    f.adapter.bindVerifiedNetworkProof(f.proof);
    let reads = 0;
    await assert.rejects(
      runUnpublishedResponseKill({
        ...f.adapter,
        async readThroughBusinessHttp(owner) {
          const value = await f.adapter.readThroughBusinessHttp(owner);
          if (++reads === 1) return value;
          return { ...value, accounting: { ...value.accounting, revision } };
        },
      }),
      { message: 'n09_ack_kill_failed' }
    );
    assert.equal(f.state.closed, 1);
    assert.equal(f.state.stopped, 2);
  }
});

test('held-response adapter requires an active seeded owner and closes independently when kill fails', async () => {
  const f = fixture();
  f.adapter.bindVerifiedNetworkProof(f.proof);
  const owner = await f.adapter.startFreshBusinessHost();
  await assert.rejects(f.adapter.beginPublicResponseHold(owner), bad);
  await f.adapter.killOwnedJob(owner);
  await f.adapter.close();
  const g = fixture();
  g.adapter.bindVerifiedNetworkProof(g.proof);
  await assert.rejects(
    runUnpublishedResponseKill({
      ...g.adapter,
      async killOwnedJob(identity) {
        await g.adapter.killOwnedJob(identity);
        throw Error('PRIVATE_KILL_SENTINEL');
      },
    }),
    { message: 'n09_ack_kill_failed' }
  );
  assert.equal(g.state.closed, 1);
  assert.equal(g.state.observedHttp.cancellations, 1);
});

test('backup revoke captures its exact revision after the completed publication barrier', async () => {
  let completed = 0;
  const f = fixture((at, value, state) => {
    if (at === 'publication-completed') {
      completed++;
      state.revision++;
    }
    if (at === 'ack-submit') {
      assert.equal(completed, 3);
      assert.equal(value.minRevision, state.revision);
    }
  });
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await runBackupRollbackAfterRevoke(f.adapter);
  assert.equal(completed, 3);
  const events = f.state.events;
  for (let index = 0; index < events.length; index++) {
    if (events[index] === 'publication-completed') assert.equal(events[index + 1], 'snapshot');
  }
  assert.deepEqual(events.slice(events.indexOf('ack'), events.indexOf('ack') + 2), ['ack', 'kill']);
});

test('failed publication readiness cannot reach the revoke command', async () => {
  for (const mode of ['false', 'throw', 'ack']) {
    const f = fixture((at, value) => {
      if (at !== 'publication-completed') return;
      if (mode === 'throw') throw Error('PRIVATE_PUBLICATION_FAILURE');
      if (mode === 'false') value.completed = false;
      if (mode === 'ack') value.hostDurableAck = true;
    });
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runBackupRollbackAfterRevoke(f.adapter), {
      message: 'n09_ack_kill_failed',
    });
    assert.equal(f.state.events.includes('submit'), false);
    assert.equal(f.state.closed, 1);
  }
});

test('backup rollback driver requires control read, actual revoke boundary and rejected HTTP', async () => {
  const f = fixture();
  f.adapter.bindVerifiedNetworkProof(f.proof);
  const receipt = await runBackupRollbackAfterRevoke(f.adapter);
  assert.equal(receipt.adapterBackupRollbackObserved, true);
  assert.equal(receipt.liveDaemonProved, false);
  assert.equal(receipt.n09Complete, false);
  assert.equal(f.state.nativeReadObserved, 2);
  assert.equal(f.state.stopped, 3);
  assert.equal(f.state.closed, 1);
  assert.equal(f.state.backupClosed, true);
  const events = f.state.events;
  assert.deepEqual(events.slice(events.indexOf('ack'), events.indexOf('ack') + 3), [
    'ack',
    'kill',
    'backup-restore',
  ]);
  assert.deepEqual(
    events.slice(events.indexOf('backup-capture') - 2, events.indexOf('backup-capture')),
    ['kill', 'snapshot']
  );
});

test('backup rollback rejects invalid evidence and preserves independent cleanup', async () => {
  for (const mutation of [
    (at, value) => {
      if (at === 'backup-capture') value.independentAnchorCaptured = true;
    },
    (at, value) => {
      if (at === 'backup-restore') value.encryptedFilesRestored = 1;
    },
    (at, value) => {
      if (at === 'rejected-storage') value.persistentStorageRejected = false;
    },
    (at, value) => {
      if (at === 'rejected-reply') value.error.code = 'unrelated_failure';
    },
    (at, value) => {
      if (at === 'rejected-reply') value.original = 'PRIVATE_SYNTHETIC_SENTINEL';
    },
    (at, _value, state) => {
      if (at === 'rejected-reply') state.rejectedStatus = 200;
    },
  ]) {
    const f = fixture(mutation);
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runBackupRollbackAfterRevoke(f.adapter), {
      message: 'n09_ack_kill_failed',
    });
    assert.equal(f.state.closed, 1);
    assert.equal(f.state.backupClosed, true);
  }
});

test('backup adapter refuses capture while live and rejected restart before restoration', async () => {
  const f = fixture();
  f.adapter.bindVerifiedNetworkProof(f.proof);
  const owner = await f.adapter.startFreshBusinessHost();
  await f.adapter.seedThroughBusinessHttp(owner);
  assert.throws(() => f.adapter.captureStoppedBackup(owner), bad);
  await assert.rejects(f.adapter.restartWithRejectedStorage(owner), bad);
  await f.adapter.killOwnedJob(owner);
  assert.throws(() => f.adapter.captureStoppedBackup({ ...owner, pid: owner.pid + 1 }), bad);
  await assert.rejects(f.adapter.restartWithRejectedStorage(owner), bad);
  await f.adapter.close();
});
test('502 diagnostics preserve failure and cleanup while exposing only fixed stage numbers', async () => {
  for (const diagnostic of [
    async () => 220,
    async () => 'PRIVATE',
    async () => {
      throw Error('PRIVATE');
    },
  ]) {
    const phases = [];
    const f = fixture(
      (_at, _value, state) => {
        state.refuseAfter = 4;
      },
      (phase) => phases.push(phase)
    );
    f.state.diagnostic = diagnostic;
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runCommittedObservedKill(f.adapter), {
      message: 'n09_committed_observed_kill_failed',
    });
    assert.equal(phases.includes(216), true);
    assert.ok([220, 224].includes(phases.at(-1)));
    assert.equal(f.state.closed, 1);
    assert.doesNotMatch(JSON.stringify(phases), /PRIVATE/);
  }
});

test('denied-receipt HTTP failure replaces completed configuration phase and preserves forced cleanup', async () => {
  const phases = [];
  const f = fixture(
    (stage, _value, state) => {
      if (stage === 'reply' && state.cleared) state.replyStatus = 503;
    },
    (phase) => phases.push(phase)
  );
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await assert.rejects(runClearAfterAck(f.adapter));
  assert.equal(phases.at(-1), 170);
  assert.equal(f.state.sent, 5);
  assert.equal(f.state.stopped, 2);
  assert.equal(f.state.closed, 1);
});

test('denied receipt distinguishes malformed envelope and wrong public answer without logging content', async () => {
  for (const expected of [225, 226]) {
    const phases = [];
    const f = fixture(
      (stage, value, state) => {
        if (stage !== 'reply' || !state.cleared) return;
        if (expected === 225) value.status = 'incomplete';
        else value.output[0].content[0].text = 'PRIVATE';
      },
      (phase) => phases.push(phase)
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runClearAfterAck(f.adapter));
    assert.equal(phases.at(-1), expected);
    assert.equal(f.state.sent, 5);
    assert.equal(f.state.stopped, 2);
    assert.equal(f.state.closed, 1);
    assert.doesNotMatch(JSON.stringify(phases), /PRIVATE/);
  }
});

test('successful denied receipt finishes all reply and no-replay assertions', async () => {
  const phases = [];
  const f = fixture(undefined, (phase) => phases.push(phase));
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await runClearAfterAck(f.adapter);
  assert.deepEqual(phases.slice(-5), [225, 226, 227, 228, 229]);
});

test('public generation before an observed read has a separate safe failure class', async () => {
  const phases = [];
  const f = fixture(
    (stage, incoming) => {
      if (stage !== 'upstream') return;
      const body = JSON.parse(incoming.bytes);
      if (!body.tools?.some((tool) => tool.name === 'hpm_list_retained_evidence')) return;
      body.tools = [];
      incoming.bytes = Buffer.from(JSON.stringify(body));
    },
    (phase) => phases.push(phase)
  );
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await assert.rejects(runCommittedObservedKill(f.adapter));
  assert.equal(phases.at(-1), 230);
  assert.equal(f.state.stopped, 2);
  assert.equal(f.state.closed, 1);
  assert.doesNotMatch(JSON.stringify(phases), /PRIVATE/);
});

test('first missing READ reports admission class only after failed HTTP and preserves forced cleanup', async () => {
  for (const diagnostic of [
    async () => 200,
    async () => 202,
    async () => 210,
    ...Array.from({ length: 7 }, (_, index) => async () => 217 + index),
    async () => 216,
    async () => 225,
    async () => 223.5,
    async () => 'PRIVATE',
    async () => {
      throw Error('PRIVATE');
    },
  ]) {
    const phases = [];
    const f = fixture(
      (stage, incoming) => {
        if (stage !== 'upstream') return;
        const body = JSON.parse(incoming.bytes);
        if (!body.tools?.some((tool) => tool.name === 'hpm_list_retained_evidence')) return;
        body.tools = [];
        incoming.bytes = Buffer.from(JSON.stringify(body));
      },
      (phase) => phases.push(phase)
    );
    let reads = 0;
    f.state.returnHttpFailure = true;
    f.state.admissionDiagnostic = async () => {
      reads++;
      assert.equal(phases.includes(230), true);
      return diagnostic();
    };
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runCommittedObservedKill(f.adapter));
    assert.equal(reads, 1);
    const expected = await diagnostic().catch(() => 224);
    assert.equal(
      phases.at(-1),
      [200, 202, 210, 217, 218, 219, 220, 221, 222, 223].includes(expected) ? expected : 224
    );
    assert.equal(f.state.stopped, 2);
    assert.equal(f.state.closed, 1);
    assert.doesNotMatch(JSON.stringify(phases), /PRIVATE/);
  }
});

test('successful clear, save and revoke never query admission-failure diagnostics', async () => {
  for (const run of [
    runClearAfterAck,
    (adapter) => runDurableSaveOrRevokeAfterAck(adapter, 'save'),
    (adapter) => runDurableSaveOrRevokeAfterAck(adapter, 'revoke'),
  ]) {
    const f = fixture();
    let reads = 0;
    f.state.admissionDiagnostic = async () => {
      reads++;
      return 202;
    };
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await run(f.adapter);
    assert.equal(reads, 0);
    assert.equal(f.state.closed, 1);
  }
});

test('diagnostic phase changes preserve the frozen synthetic original workload', async () => {
  const f = fixture();
  f.adapter.bindVerifiedNetworkProof(f.proof);
  try {
    const owner = await f.adapter.startFreshBusinessHost();
    await f.adapter.seedThroughBusinessHttp(owner);
    const prefixBytes = Buffer.byteLength('N09_PRIVATE_CONTENT ') + 32 + 1;
    assert.equal(
      Buffer.byteLength(f.state.original),
      prefixBytes + Buffer.byteLength('synthetic-evidence ') * 256
    );
    assert.equal(f.state.original.endsWith('synthetic-evidence '.repeat(256)), true);
  } finally {
    await f.adapter.close();
  }
});

test('missing READ diagnostics separate ACK-triggered and post-restart recovery without accepting either', async () => {
  for (const expected of [251, 252]) {
    const phases = [];
    const f = fixture(
      (stage, incoming, state) => {
        if (stage !== 'upstream') return;
        const selected =
          expected === 251 ? state.ackCommand?.operation === 'arm-save' : state.pid === 102;
        if (!selected) return;
        const body = JSON.parse(incoming.bytes);
        if (!body.tools?.some((tool) => tool.name === 'hpm_list_retained_evidence')) return;
        body.tools = [];
        incoming.bytes = Buffer.from(JSON.stringify(body));
      },
      (phase) => phases.push(phase)
    );
    f.state.holdSave = expected === 252;
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runDurableSaveOrRevokeAfterAck(f.adapter, 'save'));
    assert.equal(phases.at(-1), expected);
    assert.equal(f.state.stopped, expected === 251 ? 1 : 2);
    assert.equal(f.state.closed, 1);
    assert.doesNotMatch(JSON.stringify(phases), /PRIVATE/);
  }
});

test('distinct synthetic upstream responses and output items never reuse provider identities across recovery rounds', async () => {
  const responseIds = [],
    itemIds = [];
  const f = fixture((stage, response) => {
    if (stage !== 'native-reply') return;
    responseIds.push(response.id);
    for (const item of response.output) itemIds.push(item.id);
  });
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await runDurableSaveOrRevokeAfterAck(f.adapter, 'save');
  assert.ok(responseIds.length >= 11);
  assert.equal(new Set(responseIds).size, responseIds.length);
  assert.equal(new Set(itemIds).size, itemIds.length);
  assert.equal(f.state.closed, 1);
});

test('ACK handshake rejection is distinguished from a completed readonly snapshot and still forces cleanup', async () => {
  const phases = [];
  const f = fixture(
    (stage) => {
      if (stage === 'ack-submit') throw Error('PRIVATE_SENTINEL');
    },
    (phase) => phases.push(phase)
  );
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await assert.rejects(runDurableSaveOrRevokeAfterAck(f.adapter, 'save'));
  assert.equal(phases.at(-1), 155);
  assert.equal(phases.includes(254), false);
  assert.equal(f.state.stopped, 1);
  assert.equal(f.state.closed, 1);
  assert.doesNotMatch(JSON.stringify(phases), /PRIVATE/);
});

test('ACK diagnostics preserve handshake order and classify failed client methods without relaxing either boundary', async () => {
  for (const [stage, pollingStarted] of [
    ['ack-armed', false],
    ['ack-receipt', true],
  ]) {
    const phases = [];
    const f = fixture(
      (at) => {
        if (at === stage) throw Error('PRIVATE_SENTINEL');
      },
      (value) => phases.push(value)
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runDurableSaveOrRevokeAfterAck(f.adapter, 'save'));
    assert.equal(phases.at(-1), 155);
    assert.equal(phases.includes(254), pollingStarted);
    assert.equal(f.state.closed, 1);
    assert.equal(f.state.stopped, 1);
    assert.doesNotMatch(JSON.stringify(phases), /PRIVATE/);
  }
});

test('authenticated ACK failure stages reach the hosted observer with owned cleanup and no retry', async () => {
  const { fail } = require('../../scripts/context-hosted/n09-ack/contract');
  for (let stage = 140; stage <= 157; stage++) {
    const phases = [];
    let polls = 0;
    const f = fixture(
      (at) => {
        if (at === 'ack-receipt') {
          polls++;
          throw fail(stage);
        }
      },
      (phase) => phases.push(phase)
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runDurableSaveOrRevokeAfterAck(f.adapter, 'revoke'));
    assert.equal(phases.at(-1), stage);
    assert.equal(polls, 1);
    assert.equal(f.state.stopped, 1);
    assert.equal(f.state.closed, 1);
  }
});

test('synthetic public recovery output supports JSON and complete Responses SSE encoding', async () => {
  const {
    encodeContextRecoveryClientWire,
  } = require('../../lib/proxy/context-recovery-client-wire');
  const { decodeContextRecoveryResponse } = require('../../lib/proxy/context-recovery-protocol');
  let checked = 0;
  const f = fixture((at, response) => {
    if (at !== 'reply' || !response.output[0]?.content?.[0]?.text?.startsWith('N09_RECOVERY_OK '))
      return;
    for (const stream of [false, true]) {
      const encoded = encodeContextRecoveryClientWire(
        'responses',
        response,
        [response.usage],
        stream
      );
      const decoded = decodeContextRecoveryResponse('responses', encoded.wire, stream);
      assert.deepEqual(JSON.parse(JSON.stringify(decoded.output)), response.output);
    }
    checked++;
  });
  f.adapter.bindVerifiedNetworkProof(f.proof);
  try {
    await runCommittedObservedKill(f.adapter);
    assert.equal(checked, 1);
  } finally {
    await f.adapter.close();
  }
});
test('seed observer separates HTTP completion, protocol validation and metadata snapshot without removing work', async () => {
  const phases = [],
    f = fixture(undefined, (phase) => phases.push(phase));
  f.adapter.bindVerifiedNetworkProof(f.proof);
  const owner = await f.adapter.startFreshBusinessHost();
  const result = await f.adapter.seedThroughBusinessHttp(owner);
  assert.deepEqual(phases, [109, 110, 111, 131, 132, 133, 134, 135, 136, 137, 138]);
  assert.equal(f.state.sent, 3);
  assert.equal(result.rootId, f.state.rootId);
  await f.adapter.killOwnedJob(owner);
  await f.adapter.close();
  assert.equal(f.state.stopped, 1);
  assert.equal(f.state.closed, 1);
});

test('every seed observer failure remains fixed and retains forced owned cleanup', async () => {
  for (let rejected = 131; rejected <= 138; rejected++) {
    const phases = [],
      f = fixture(undefined, (phase) => {
        phases.push(phase);
        if (phase === rejected) throw new Error('PRIVATE_SENTINEL');
      });
    f.adapter.bindVerifiedNetworkProof(f.proof);
    const owner = await f.adapter.startFreshBusinessHost();
    await assert.rejects(f.adapter.seedThroughBusinessHttp(owner), bad);
    assert.equal(phases.at(-1), rejected);
    await f.adapter.killOwnedJob(owner);
    await f.adapter.close();
    assert.equal(f.state.stopped, 1);
    assert.equal(f.state.closed, 1);
  }
});

test('business startup observer reports only fixed phases and propagates to lifecycle', async () => {
  const f = fixture();
  const phases = [];
  const onPhase = (phase) => phases.push(phase);
  const adapter = createN09BusinessAdapter(f.options, {
    ...f.trusted,
    onPhase,
    createLifecycle(input, dependencies) {
      assert.equal(dependencies.onPhase, onPhase);
      return f.trusted.createLifecycle(input, dependencies);
    },
  });
  adapter.bindVerifiedNetworkProof(f.proof);
  await adapter.startFreshBusinessHost();
  assert.deepEqual(phases, [109, 110, 111]);
  assert.equal(f.state.configured, 1);
  await adapter.close();
  assert.equal(f.state.closed, 1);
});

test('business startup observer rejects invalid dependencies without executing proxies', () => {
  const f = fixture();
  let traps = 0;
  const proxy = new Proxy(() => {}, {
    get() {
      traps++;
      throw new Error('private');
    },
  });
  for (const onPhase of [null, 0, '', {}, proxy]) {
    assert.throws(() => createN09BusinessAdapter(f.options, { ...f.trusted, onPhase }), bad);
  }
  assert.equal(traps, 0);
  assert.equal(f.state.created, 0);
});

test('business startup observer failures are sanitized and retain owned cleanup at each phase', async () => {
  for (const rejected of [109, 110, 111]) {
    const f = fixture();
    const phases = [];
    const adapter = createN09BusinessAdapter(f.options, {
      ...f.trusted,
      onPhase(phase) {
        phases.push(phase);
        if (phase === rejected) throw new Error('PRIVATE_OBSERVER_SENTINEL');
      },
    });
    adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(adapter.startFreshBusinessHost(), bad);
    assert.deepEqual(
      phases,
      [109, 110, 111].filter((phase) => phase <= rejected)
    );
    await adapter.close();
    assert.equal(f.state.closed, rejected === 109 ? 0 : 1);
  }
});

test('passive construction and branded proof gate prevent premature spawn/HTTP', async () => {
  const f = fixture();
  assert.equal(f.state.created, 0);
  assert.equal(f.state.sent, 0);
  await assert.rejects(f.adapter.startFreshBusinessHost(), bad);
  assert.throws(() => f.adapter.bindVerifiedNetworkProof({ pure: true }), bad);
  f.adapter.bindVerifiedNetworkProof(f.proof);
  assert.throws(() => f.adapter.bindVerifiedNetworkProof(f.proof), bad);
  await f.adapter.close();
});

for (const operation of ['save', 'revoke']) {
  test(`signed ${operation} path integrates business driver and kills before draining pending HTTP`, async () => {
    const f = fixture();
    assert.equal(typeof f.adapter.existingHostDurableAckCapability(operation), 'function');
    let inspections = 0;
    f.state.diagnostic = async () => {
      inspections++;
      return 218;
    };
    assert.equal(f.state.created, 0);
    assert.equal(f.state.sent, 0);
    f.state.holdSave = operation === 'save';
    f.adapter.bindVerifiedNetworkProof(f.proof);
    const result = await runDurableSaveOrRevokeAfterAck(f.adapter, operation);
    assert.equal(result.adapterDurableAckObserved, true);
    assert.equal(result.liveDaemonProved, false);
    assert.equal(result.n09Complete, false);
    assert.equal(f.state.closed, 1);
    assert.equal(f.state.stopped, 2);
    const ackIndex = f.state.events.indexOf('ack');
    assert.equal(f.state.events[ackIndex + 1], 'kill');
    assert.equal(inspections, 0);
    assert.equal(f.state.nativeReadObserved, operation === 'save' ? 3 : 1);
    if (operation === 'save') {
      assert.ok(f.state.events.indexOf('armed') < f.state.events.indexOf('http-pending'));
    } else {
      assert.equal(f.state.sent, 9); // seed 3 + initial read 1 + denied 5; no revoke HTTP
      assert.equal(f.state.events.includes('armed'), false);
    }
  });
}

test('invalid final durable ACK fails driver and still terminates pending business work', async () => {
  const f = fixture((at, receipt) => {
    if (at === 'ack') receipt.pid = 999;
  });
  f.state.holdSave = true;
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await assert.rejects(runDurableSaveOrRevokeAfterAck(f.adapter, 'save'), {
    message: 'n09_ack_kill_failed',
  });
  assert.equal(f.state.closed, 1);
  assert.equal(f.state.stopped, 1);
});

test('business response failure before final ACK cannot be hidden by receipt polling', async () => {
  const f = fixture((at, value, state) => {
    if (
      at === 'reply' &&
      state.ackCommand &&
      value.output[0]?.content?.[0]?.text?.startsWith('N09_RECOVERY_OK')
    )
      value.status = 'failed';
  });
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await assert.rejects(runDurableSaveOrRevokeAfterAck(f.adapter, 'save'), {
    message: 'n09_ack_kill_failed',
  });
  assert.equal(f.state.events.includes('ack'), false);
  assert.equal(f.state.stopped, 1);
  assert.equal(f.state.closed, 1);
});

test('save ACK response refusals retain fixed HTTP diagnostics and forced cleanup', async () => {
  for (const [status, expected] of [
    [401, 163],
    [403, 164],
    [502, 216],
    [503, 170],
    [504, 171],
  ]) {
    const phases = [];
    const f = fixture(
      (kind, _value, state) => {
        if (kind === 'reply' && state.ackCommand) state.replyStatus = status;
      },
      (phase) => phases.push(phase)
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runDurableSaveOrRevokeAfterAck(f.adapter, 'save'), {
      message: 'n09_ack_kill_failed',
    });
    assert.equal(phases.at(-1), expected);
    assert.equal(f.state.events.includes('ack'), false);
    assert.equal(f.state.sent, 5);
    assert.equal(f.state.stopped, 1);
    assert.equal(f.state.closed, 1);
  }
});

test('failed save ACK can inspect only the existing finite failure diagnostic before forced cleanup', async () => {
  for (const diagnostic of [
    async () => 218,
    async () => 'PRIVATE_SENTINEL',
    async () => {
      throw Error('PRIVATE_SENTINEL');
    },
  ]) {
    const phases = [];
    let inspections = 0;
    const f = fixture(
      (kind, _value, state) => {
        if (kind === 'reply' && state.ackCommand) state.replyStatus = 502;
      },
      (phase) => phases.push(phase)
    );
    f.state.diagnostic = async () => {
      inspections++;
      return diagnostic();
    };
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runDurableSaveOrRevokeAfterAck(f.adapter, 'save'), {
      message: 'n09_ack_kill_failed',
    });
    assert.equal(inspections, 1);
    assert.ok([218, 224].includes(phases.at(-1)));
    assert.equal(phases.includes(216), true);
    assert.equal(f.state.events.includes('ack'), false);
    assert.equal(f.state.sent, 5);
    assert.equal(f.state.stopped, 1);
    assert.equal(f.state.closed, 1);
    assert.equal(JSON.stringify(phases).includes('PRIVATE'), false);
  }
});

test('save ACK early 502 retains each fixed recovery boundary without retry', async () => {
  for (let after = 0; after <= 4; after++) {
    const phases = [];
    const f = fixture(
      (kind, _value, state) => {
        if (kind === 'ack-submit') state.refuseAfter = after;
      },
      (phase) => phases.push(phase)
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runDurableSaveOrRevokeAfterAck(f.adapter, 'save'), {
      message: 'n09_ack_kill_failed',
    });
    assert.deepEqual(phases.slice(-2), [169, 212 + after]);
    assert.equal(f.state.events.includes('ack'), false);
    assert.equal(f.state.sent, 5);
    assert.equal(f.state.stopped, 1);
    assert.equal(f.state.closed, 1);
  }
});

test('passively acquired ACK callable sanitizes late precondition failures', async () => {
  const f = fixture((at, _value, state) => {
    if (at === 'snapshot' && state.rejectSnapshot) throw new Error('PRIVATE_precondition');
  });
  const capability = f.adapter.existingHostDurableAckCapability('save');
  f.adapter.bindVerifiedNetworkProof(f.proof);
  const owner = await f.adapter.startFreshBusinessHost();
  await f.adapter.seedThroughBusinessHttp(owner);
  await f.adapter.readThroughBusinessHttp(owner);
  f.state.rejectSnapshot = true;
  await assert.rejects(capability(owner), bad);
  assert.equal(f.state.events.includes('submit'), false);
  await f.adapter.close();
});
test('full pure committed-observed orchestration verifies READ sha, receipt binding and no original replay', async () => {
  const f = fixture();
  f.adapter.bindVerifiedNetworkProof(f.proof);
  const result = await runCommittedObservedKill(f.adapter);
  assert.equal(result.sequence, 'committed-observed-kill');
  assert.equal(result.liveDaemonProved, false);
  assert.equal(f.state.nativeReadObserved, 1);
  assert.equal(f.state.configured, 1);
  assert.equal(f.state.stopped, 2);
  assert.equal(f.state.closed, 1);
  const observed = f.adapter.inspectBusinessEvidence();
  assert.equal(observed.seeded, true);
  assert.equal(observed.validatedReadCount, 1);
  assert.equal(observed.publicGenerationCount, 1);
  assert.equal(observed.clearAckCount, 0);
  assert.equal(observed.externalToolExecutions, 1);
});
test('existing clear ACK driver reuses actual business methods and four policy combinations', async () => {
  const f = fixture();
  f.adapter.bindVerifiedNetworkProof(f.proof);
  const result = await runClearAfterAck(f.adapter);
  assert.equal(result.adapterClearBoundaryObserved, true);
  assert.equal(result.liveDaemonProved, false);
  assert.equal(f.state.nativeReadObserved, 1);
  assert.equal(f.state.cleared, true);
  assert.equal(f.state.configured, 1);
  assert.equal(f.state.closed, 1);
  const observed = f.adapter.inspectBusinessEvidence();
  assert.equal(observed.seeded, true);
  assert.equal(observed.validatedReadCount, 1);
  assert.equal(observed.publicGenerationCount, 1);
  assert.equal(observed.clearAckCount, 1);
  assert.equal(observed.externalToolExecutions, 1);
});
for (const fault of [
  'authorization',
  'list-digest',
  'read-sha',
  'read-source',
  'read-empty',
  'read-range',
  'public-missing',
  'public-tool',
]) {
  test(`reject ${fault} with fixed error and owned cleanup`, async () => {
    const f = fixture((at, value) => {
      if (fault === 'authorization' && at === 'upstream') value.authorization = 'Bearer PRIVATE';
      if (fault === 'list-digest' && at === 'list') value.digest = '0'.repeat(64);
      if (fault === 'read-sha' && at === 'read') value.page.text = 'PRIVATE';
      if (fault === 'read-source' && at === 'read') value.source.sourceId = 'hce_' + 'f'.repeat(32);
      if (fault === 'read-empty' && at === 'read') value.page.text = '';
      if (fault === 'read-range' && at === 'read')
        value.page.endOffsetBytes = Number.MAX_SAFE_INTEGER;
      if (fault === 'public-missing' && at === 'public') value.input = [];
      if (
        fault === 'public-tool' &&
        at === 'reply' &&
        value.output[0]?.content?.[0]?.text?.startsWith('N09_RECOVERY_OK')
      )
        value.output = [{ type: 'function_call', name: 'n09_original' }];
    });
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runCommittedObservedKill(f.adapter), {
      message: 'n09_committed_observed_kill_failed',
    });
    assert.equal(f.state.closed, 1);
  });
}
test('constructor and identity getters/proxies do not run', async () => {
  const f = fixture();
  let traps = 0;
  assert.throws(
    () =>
      createN09BusinessAdapter({
        ...f.options,
        get install() {
          traps++;
          return f.options.install;
        },
      }),
    bad
  );
  assert.throws(
    () =>
      createN09BusinessAdapter(f.options, {
        get spawn() {
          traps++;
          return () => {};
        },
      }),
    bad
  );
  f.adapter.bindVerifiedNetworkProof(f.proof);
  const identity = await f.adapter.startFreshBusinessHost();
  assert.throws(
    () =>
      f.adapter.readCommittedSnapshot(
        new Proxy(identity, {
          get() {
            traps++;
            return undefined;
          },
        })
      ),
    bad
  );
  assert.equal(traps, 0);
  await f.adapter.close();
});
test('snapshot after kill is bound to a stopped owner and is unavailable before kill or after restart', async () => {
  const f = fixture();
  f.adapter.bindVerifiedNetworkProof(f.proof);
  const owner = await f.adapter.startFreshBusinessHost();
  await f.adapter.seedThroughBusinessHttp(owner);
  assert.throws(() => f.adapter.readCommittedSnapshotAfterKill(owner), bad);
  await f.adapter.killOwnedJob(owner);
  assert.throws(
    () => f.adapter.readCommittedSnapshotAfterKill({ ...owner, pid: owner.pid + 1 }),
    bad
  );
  let traps = 0;
  assert.throws(
    () =>
      f.adapter.readCommittedSnapshotAfterKill(
        new Proxy(owner, {
          ownKeys() {
            traps++;
            throw Error('PRIVATE_SENTINEL');
          },
        })
      ),
    bad
  );
  assert.equal(traps, 0);
  assert.equal(f.adapter.readCommittedSnapshotAfterKill(owner).rootId, f.state.rootId);
  await f.adapter.restartSameBusinessHost(owner);
  assert.throws(() => f.adapter.readCommittedSnapshotAfterKill(owner), bad);
  await f.adapter.close();
  assert.throws(() => f.adapter.readCommittedSnapshotAfterKill(owner), bad);
});

test('upstream oversized, invalid UTF8 and invalid JSON fail without response writes', async () => {
  const f = fixture();
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await f.adapter.startFreshBusinessHost();
  for (const bytes of [Buffer.alloc(262145), Buffer.from([255]), Buffer.from('{')]) {
    const response = {
      destroyed: false,
      headersSent: false,
      writeHead() {
        throw new Error('unexpected-write');
      },
      end() {},
    };
    await assert.rejects(
      f.adapter.onBusinessRequest({
        path: '/v1/responses',
        authorization: 'Bearer ' + f.state.config.upstreamKey,
        bytes,
        response,
      }),
      bad
    );
  }
  await f.adapter.close();
});

test('N09 rejected tool-result HTTP status retains fixed classification and owned cleanup', async () => {
  for (const [status, expected] of [
    [400, 162],
    [401, 163],
    [403, 164],
    [409, 165],
    [413, 166],
    [429, 167],
    [500, 168],
    [502, 169],
    [503, 170],
    [504, 171],
    [418, 172],
  ]) {
    const phases = [];
    const f = fixture(
      (kind, _value, state) => {
        if (kind === 'reply' && state.sent === 2) state.replyStatus = status;
      },
      (phase) => phases.push(phase)
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    const owner = await f.adapter.startFreshBusinessHost();
    await assert.rejects(f.adapter.seedThroughBusinessHttp(owner), bad);
    assert.equal(phases.at(-1), status === 502 ? 211 : expected);
    assert.equal(f.state.sent, 2);
    await f.adapter.killOwnedJob(owner);
    await f.adapter.close();
    assert.equal(f.state.stopped, 1);
    assert.equal(f.state.closed, 1);
  }
});

test('N09 restarted recovery HTTP refusal reports its fixed status and never retries business', async () => {
  for (const [status, expected] of [
    [401, 163],
    [403, 164],
    [502, 169],
    [503, 170],
    [504, 171],
  ]) {
    const phases = [];
    const f = fixture(
      (kind, _value, state) => {
        if (kind === 'reply' && state.sent === 4) state.replyStatus = status;
      },
      (phase) => phases.push(phase)
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(
      runCommittedObservedKill(f.adapter),
      /^Error: n09_committed_observed_kill_failed$/
    );
    assert.equal(phases.at(-1), status === 502 ? 216 : expected);
    assert.equal(f.state.sent, 4);
    assert.equal(f.state.stopped, 2);
    assert.equal(f.state.closed, 1);
  }
});

test('N09 502 progress distinguishes every recovery boundary without retry or content disclosure', async () => {
  for (let after = 0; after <= 4; after++) {
    const phases = [];
    const f = fixture(undefined, (phase) => phases.push(phase));
    f.state.refuseAfter = after;
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(
      runCommittedObservedKill(f.adapter),
      /^Error: n09_committed_observed_kill_failed$/
    );
    assert.deepEqual(phases.slice(-2), [169, 212 + after]);
    assert.equal(f.state.sent, 4);
    assert.equal(f.state.stopped, 2);
    assert.equal(f.state.closed, 1);
  }
});

test('synthetic upstream failures expose only their fixed request, index, page or public boundary and retain cleanup', async () => {
  for (const expected of [196, 197, 203, 231]) {
    const phases = [];
    const f = fixture(
      (kind, incoming, state) => {
        if (kind !== 'upstream' || state.sent !== 4) return;
        const body = JSON.parse(incoming.bytes);
        if (expected === 196) body.instructions = 'PRIVATE_INVALID';
        if (expected === 197 || expected === 203) {
          const prefix = expected === 197 ? 'n09_list_' : 'n09_read_';
          const item = body.input.find(
            (value) => value.type === 'function_call_output' && value.call_id.startsWith(prefix)
          );
          if (item) {
            const value = JSON.parse(item.output);
            if (expected === 197) value.sources = [];
            else value.page.text = 'PRIVATE_INVALID';
            item.output = JSON.stringify(value);
          }
        }
        if (
          expected === 231 &&
          !body.tools.some((tool) => tool.name === 'hpm_list_retained_evidence')
        )
          body.input = [{ role: 'user', content: 'PRIVATE_INVALID' }];
        incoming.bytes = Buffer.from(JSON.stringify(body));
      },
      (phase) => phases.push(phase)
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(
      runCommittedObservedKill(f.adapter),
      /^Error: n09_committed_observed_kill_failed$/
    );
    assert.equal(phases.at(-1), expected);
    assert.equal(f.state.sent, 4);
    assert.equal(f.state.stopped, 2);
    assert.equal(f.state.closed, 1);
    assert.equal(JSON.stringify(phases).includes('PRIVATE'), false);
  }
});

test('restart index must preserve the exact authenticated source receipt, including scoped call ID and expiry', async () => {
  for (const key of [
    'sourceId',
    'callId',
    'expiresAt',
    'argumentsDigest',
    'digest',
    'bytes',
    'toolName',
  ]) {
    const phases = [];
    const f = fixture(
      (kind, incoming, state) => {
        if (kind !== 'upstream' || state.sent !== 4) return;
        const body = JSON.parse(incoming.bytes);
        const item = body.input.find(
          (value) => value.type === 'function_call_output' && value.call_id.startsWith('n09_list_')
        );
        if (!item) return;
        const value = JSON.parse(item.output);
        const source = value.sources[0];
        if (key === 'expiresAt' || key === 'bytes') source[key]++;
        else if (key === 'callId') source[key] = state.originalCallId;
        else if (key === 'sourceId') source[key] = 'hce_' + 'd'.repeat(32);
        else if (key === 'toolName') source[key] = 'other';
        else source[key] = 'd'.repeat(64);
        item.output = JSON.stringify(value);
        incoming.bytes = Buffer.from(JSON.stringify(body));
      },
      (phase) => phases.push(phase)
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(
      runCommittedObservedKill(f.adapter),
      /^Error: n09_committed_observed_kill_failed$/
    );
    assert.equal(phases.at(-1), 197, key);
    assert.equal(f.state.sent, 4);
    assert.equal(f.state.stopped, 2);
    assert.equal(f.state.closed, 1);
  }
});

test('read refusal diagnostics distinguish fixed error categories, malformed envelopes and valid partial pages without exposing replies', async () => {
  for (const [expected, error] of [
    [201],
    [203],
    [205],
    [206, 'context_evidence_unavailable'],
    [206, 'context_recovery_storage_unavailable'],
    [207, 'context_artifact_budget_exceeded'],
    [207, 'evidence_read_budget_exceeded'],
    [208, 'context_artifact_invalid_range'],
    [209, 'PRIVATE_INVALID'],
  ]) {
    const phases = [];
    const f = fixture(
      (kind, incoming, state) => {
        if (kind !== 'upstream' || state.sent !== 4) return;
        const body = JSON.parse(incoming.bytes);
        const item = body.input.find(
          (value) => value.type === 'function_call_output' && value.call_id.startsWith('n09_read_')
        );
        if (!item) return;
        const value = JSON.parse(item.output);
        if (expected === 203) delete value.page.chunkDigest;
        if (expected === 205) {
          value.page.text = value.page.text.slice(0, 10);
          value.page.endOffsetBytes = 10;
          value.page.nextOffsetBytes = 10;
          value.page.chunkDigest = sha(value.page.text);
        }
        item.output =
          expected === 201
            ? 'PRIVATE_INVALID'
            : JSON.stringify(error ? { ok: false, error } : value);
        incoming.bytes = Buffer.from(JSON.stringify(body));
      },
      (phase) => phases.push(phase)
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(
      runCommittedObservedKill(f.adapter),
      /^Error: n09_committed_observed_kill_failed$/
    );
    assert.equal(phases.at(-1), expected);
    assert.equal(f.state.sent, 4);
    assert.equal(f.state.stopped, 2);
    assert.equal(f.state.closed, 1);
    assert.equal(JSON.stringify(phases).includes('PRIVATE'), false);
  }
});

test('prepared daemon orchestration refuses compensation, stale version and recovered metadata changes', async () => {
  for (const patch of [
    { transition: 'withdrawn' },
    { expectedRevision: 0 },
    { expiresAt: 10001 },
    { activeCount: 2 },
  ]) {
    const f = fixture(
      (stage, value, state) => {
        if (stage === 'publication-query' && state.commitQueued) Object.assign(value, patch);
      },
      undefined,
      true
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runPreparedPublicationCommit(f.adapter, true), {
      message: 'n09_publication_commit_driver_failed',
    });
    assert.equal(f.state.closed, 1);
  }
  const f = fixture(
    (stage, _value, state) => {
      if (stage === 'snapshot' && state.stopped > 0) state.revision++;
    },
    undefined,
    true
  );
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await assert.rejects(runPreparedPublicationCommit(f.adapter, true), {
    message: 'n09_publication_commit_driver_failed',
  });
  assert.equal(f.state.closed, 1);
});

test('prepared ACK driver uses the real adapter to kill after durable revision or complete a released public response', async () => {
  for (const kill of [true, false]) {
    const f = fixture(() => {}, undefined, 'ack');
    f.adapter.bindVerifiedNetworkProof(f.proof);
    const receipt = await runPreparedPublicationAck(f.adapter, kill);
    assert.equal(receipt.boundary, 'prepared-durable-store-before-host-ack');
    assert.equal(receipt.forcedKill, kill);
    assert.equal(receipt.positivePublicCompletion, !kill);
    assert.equal(receipt.opaqueAckNotDeliveredAtKill, kill);
    assert.equal(receipt.originalReadAfterRestart, true);
    assert.equal(f.state.events.includes('ack-release'), !kill);
    assert.equal(f.state.events.indexOf('ack-held') < f.state.events.indexOf('kill'), true);
    const evidence = f.adapter.inspectBusinessEvidence();
    assert.equal(evidence.validatedReadCount, 3);
    assert.equal(evidence.publicGenerationCount, 3);
    assert.equal(f.state.closed, 1);
  }
});

test('prepared ACK driver refuses signed signals with stale, future or different binding and always cleans up', async () => {
  for (const [stage, patch] of [
    ['armed', { pid: 999 }],
    ['armed', { generation: 2 }],
    ['armed', { revision: 0 }],
    ['held', { revision: 1 }],
    ['held', { revision: 999 }],
    ['held', { callOrdinal: 1 }],
    ['held', { rootId: 'hbs_' + 'a'.repeat(32) }],
    ['held', { expiresAt: 99999 }],
    ['held', { challenge: 'a'.repeat(32) }],
    ['released', { holdChallenge: 'b'.repeat(32) }],
  ]) {
    const f = fixture(
      (at, value) => {
        if (at === 'prepared-ack-' + stage) Object.assign(value, patch);
      },
      undefined,
      'ack'
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runPreparedPublicationAck(f.adapter, stage !== 'released'), {
      message: 'n09_publication_ack_driver_failed',
    });
    assert.equal(f.state.closed, 1);
  }
});

test('prepared ACK qualification refuses durable budget drift, expiry renewal, public bytes and false completion', async () => {
  for (const scenario of ['budget', 'expiry', 'bytes', 'completion', 'reopen-version']) {
    let changed = false;
    const f = fixture(
      (stage, value, state) => {
        if (stage === 'prepared-ack-held') {
          if (scenario === 'budget') state.calls--;
          if (scenario === 'expiry') state.expiresAt++;
          if (scenario === 'bytes') state.observedHttp.bytes = 1;
        }
        if (scenario === 'completion' && stage === 'publication-completed' && state.ackQueued)
          value.completed = false;
        if (
          scenario === 'reopen-version' &&
          stage === 'snapshot' &&
          state.stopped === 1 &&
          !changed
        ) {
          state.revision++;
          changed = true;
        }
      },
      undefined,
      'ack'
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runPreparedPublicationAck(f.adapter, scenario !== 'completion'), {
      message: 'n09_publication_ack_driver_failed',
    });
    assert.equal(f.state.closed, 1);
  }
});

test('sending ACK business control requires a durable two-version advance without changing held budget or expiry', async () => {
  for (const kill of [true, false]) {
    const f = fixture(() => {}, undefined, 'ack');
    f.adapter.bindVerifiedNetworkProof(f.proof);
    const result = await runPreparedPublicationAck(f.adapter, kill, 'sending');
    assert.equal(result.boundary, 'sending-durable-store-before-host-ack');
    assert.equal(result.preparedPredecessorAckObserved, true);
    assert.equal(result.positivePublicCompletion, !kill);
    assert.equal(f.state.closed, 1);
  }
});

test('sending ACK cannot qualify only one durable version even with an authenticated held signal', async () => {
  const f = fixture(
    (stage, _value, state) => {
      if (stage === 'prepared-ack-held') state.revision--;
    },
    undefined,
    'ack'
  );
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await assert.rejects(runPreparedPublicationAck(f.adapter, true, 'sending'), {
    message: 'n09_publication_ack_driver_failed',
  });
  assert.equal(f.state.closed, 1);
});

test('transport-finished ACK keeps complete public wire separate from final durable publication completion', async () => {
  for (const kill of [true, false]) {
    const f = fixture(() => {}, undefined, 'ack');
    f.adapter.bindVerifiedNetworkProof(f.proof);
    const result = await runPreparedPublicationAck(f.adapter, kill, 'transport-finished');
    assert.equal(result.boundary, 'transport-finished-durable-store-before-host-ack');
    assert.equal(result.publicTransportCompletedBeforeBoundary, true);
    assert.equal(result.sendingPredecessorAckObserved, true);
    assert.equal(result.interruptedWithZeroPublicBytes, false);
    assert.equal(result.publicationCompletionObserved, !kill);
    assert.equal(
      f.state.events.indexOf('public-wire-before-ack') < f.state.events.indexOf('kill'),
      true
    );
    assert.equal(f.state.closed, 1);
  }
});

test('finished ACK rejects partial versions, changed wire bytes and a late metadata observation under the same 750ms witness', async () => {
  for (const scenario of ['version', 'bytes', 'content', 'late-snapshot', 'completion']) {
    let delayed = false;
    const phases = [];
    const f = fixture(
      (stage, value, state) => {
        if (stage === 'prepared-ack-held') {
          if (scenario === 'version') state.revision--;
          if (scenario === 'bytes') state.observedHttp.bytes--;
          if (scenario === 'content') state.publicWireResponse.bytes[0] ^= 1;
        }
        if (
          scenario === 'late-snapshot' &&
          stage === 'snapshot' &&
          state.ackQueued &&
          state.stopped === 0 &&
          !delayed
        ) {
          delayed = true;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 760);
        }
        if (scenario === 'completion' && stage === 'publication-completed' && state.ackQueued)
          value.completed = false;
      },
      (phase) => phases.push(phase),
      'ack'
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(
      runPreparedPublicationAck(f.adapter, scenario !== 'completion', 'transport-finished'),
      { message: 'n09_publication_ack_driver_failed' }
    );
    if (scenario === 'late-snapshot') assert.equal(phases.at(-1), 250);
    if (scenario === 'completion') assert.equal(phases.at(-1), 249);
    assert.equal(f.state.closed, 1);
  }
});

for (const transition of ['withdrawn', 'uncertain']) {
  test(
    transition +
      ' ACK driver cancels before terminal durable ACK and retains original after reopen',
    async () => {
      for (const kill of [true, false]) {
        const f = fixture(() => {}, undefined, 'ack');
        f.adapter.bindVerifiedNetworkProof(f.proof);
        const receipt = await runPreparedPublicationAck(f.adapter, kill, transition);
        assert.equal(receipt.boundary, transition + '-durable-store-before-host-ack');
        assert.equal(receipt.cancellationBeforeTerminalAckObserved, true);
        assert.equal(receipt.clientTransportClosedBeforeBoundary, true);
        assert.equal(receipt.publicTransportCompletedBeforeBoundary, false);
        assert.equal(receipt.positivePublicCompletion, false);
        assert.equal(receipt.publicationCompletionObserved, false);
        assert.equal(receipt.publicationCleanupObserved, !kill);
        assert.equal(receipt.originalReadAfterRestart, true);
        assert.equal(receipt.originalExpiryPreserved, true);
        assert.ok(
          f.state.events.indexOf('ack-trigger-held') < f.state.events.indexOf('ack-trigger-release')
        );
        assert.ok(
          f.state.events.indexOf('ack-trigger-release') < f.state.events.indexOf('ack-held')
        );
        assert.equal(f.state.events.includes('cancellation-completed'), !kill);
        assert.equal(f.state.closed, 1);
      }
    }
  );
}

test('terminal ACK business adapter refuses false cancellation, reused trigger, budget drift and failed cleanup', async () => {
  for (const transition of ['withdrawn', 'uncertain']) {
    for (const scenario of [
      'transport',
      'bytes',
      'nonce',
      'revision',
      'budget',
      'expiry',
      'cleanup',
      'ack-authority',
    ]) {
      const f = fixture(
        (stage, value, state) => {
          if (stage === 'prepared-ack-trigger-held') {
            if (scenario === 'transport') state.observedHttp.reason = 'transport-error';
            if (scenario === 'bytes') state.observedHttp.bytes = 1;
          }
          if (stage === 'prepared-ack-held') {
            if (scenario === 'nonce') value.holdChallenge = 'b'.repeat(32);
            if (scenario === 'revision') value.revision++;
            if (scenario === 'budget') state.calls--;
            if (scenario === 'expiry') state.expiresAt++;
          }
          if (stage === 'cancellation-completed') {
            if (scenario === 'cleanup') value.cleanupFinished = false;
            if (scenario === 'ack-authority') value.hostDurableAck = true;
          }
        },
        undefined,
        'ack'
      );
      f.adapter.bindVerifiedNetworkProof(f.proof);
      await assert.rejects(runPreparedPublicationAck(f.adapter, false, transition), {
        message: 'n09_publication_ack_driver_failed',
      });
      assert.equal(f.state.closed, 1);
    }
  }
});

test('ACK progress separates held signal, public wire and release failures without granting a receipt', async () => {
  for (const [stage, patch, expected] of [
    ['held', { revision: 1 }, 247],
    ['held', { holdChallenge: 'bad' }, 247],
    ['released', { holdChallenge: 'b'.repeat(32) }, 249],
  ]) {
    const phases = [];
    const f = fixture(
      (at, value) => {
        if (at === 'prepared-ack-' + stage) Object.assign(value, patch);
      },
      (phase) => phases.push(phase),
      'ack'
    );
    f.adapter.bindVerifiedNetworkProof(f.proof);
    await assert.rejects(runPreparedPublicationAck(f.adapter, false, 'transport-finished'), {
      message: 'n09_publication_ack_driver_failed',
    });
    assert.equal(phases.at(-1), expected);
    assert.equal(f.state.closed, 1);
  }
  const phases = [];
  const f = fixture(
    (stage, _value, state) => {
      if (stage === 'prepared-ack-held') state.publicWireResponse.bytes[0] ^= 1;
    },
    (phase) => phases.push(phase),
    'ack'
  );
  f.adapter.bindVerifiedNetworkProof(f.proof);
  await assert.rejects(runPreparedPublicationAck(f.adapter, false, 'transport-finished'), {
    message: 'n09_publication_ack_driver_failed',
  });
  assert.equal(phases.at(-1), 248);
  assert.equal(f.state.closed, 1);
});

for (const transition of ['sending', 'transport-finished', 'withdrawn', 'uncertain']) {
  test(
    transition +
      ' COMMIT driver uses its real predecessor controls, read-lock composition and exact rollback version',
    async () => {
      const cases = {},
        businessEvidence = {};
      const name = transition === 'transport-finished' ? 'finished' : transition;
      for (const kill of [true, false]) {
        const f = fixture(
          (stage, input, state) => {
            if (stage !== 'commit-create') return;
            assert.equal(state.ackProbeActive, true);
            assert.equal(input.expectedRevision, state.revision);
            assert.equal(
              state.observedHttp.reason,
              ['withdrawn', 'uncertain'].includes(transition) ? 'cancelled-transport' : 'pending'
            );
            assert.equal(state.ackQueued || state.triggerQueued, true);
          },
          undefined,
          'ack-commit'
        );
        f.adapter.bindVerifiedNetworkProof(f.proof);
        const result = await runTransitionPublicationCommit(f.adapter, kill, transition);
        assert.equal(result.boundary, transition + '-save-reference-state-commit-pending');
        assert.equal(result.actualTargetWritePending, true);
        assert.equal(result.readAdmissionBlocked, true);
        assert.equal(result.predecessorAckObserved, true);
        assert.equal(
          result.publicTransportCompletedBeforeBoundary,
          transition === 'transport-finished'
        );
        assert.equal(
          result.cancellationBeforeBoundary,
          ['withdrawn', 'uncertain'].includes(transition)
        );
        assert.equal(result.originalReadAfterRestart, true);
        assert.equal(result.originalExpiryPreserved, true);
        assert.equal(result.n09Complete, false);
        assert.equal(f.state.closed, 1);
        const key = name + 'Commit' + (kill ? 'Kill' : 'Release');
        cases[key] = result;
        businessEvidence[key] = f.adapter.inspectBusinessEvidence();
      }
      const {
        transitionCommitClosedReceipt,
      } = require('../../scripts/context-hosted/n09/transition-commit-result');
      const receipt = transitionCommitClosedReceipt(
        {
          ...cases,
          businessEvidence,
          networkProof: {
            probesPassed: true,
            tlsVerified: true,
            nonLoopbackBlocked: true,
            listenerOwned: true,
          },
          originalControllerReused: true,
          tlsValidationDisabled: false,
          remoteModelRequests: 0,
          n09Complete: false,
          cleanup: { adaptersClosed: 2, listenerClosed: true },
        },
        name + '-commit'
      );
      assert.equal(receipt.cases, 2);
      assert.equal(receipt.n09Complete, false);
    }
  );
}

test('transition COMMIT composition rejects wrong targets, predecessor drift, public bytes and failed cleanup', async () => {
  for (const transition of ['sending', 'transport-finished', 'withdrawn', 'uncertain']) {
    const cancellation = ['withdrawn', 'uncertain'].includes(transition);
    for (const scenario of [
      'target',
      'revision',
      'budget',
      'expiry',
      'release',
      'outcome',
      'reopen',
    ]) {
      let changed = false;
      const f = fixture(
        (stage, value, state) => {
          if (stage === 'publication-query' && state.commitQueued) {
            if (scenario === 'target') value.transition = 'prepared';
            if (scenario === 'revision') value.expectedRevision++;
          }
          if (
            stage === 'snapshot' &&
            state.ackTarget &&
            !state.commitWitnessActive &&
            (state.ackQueued || state.triggerQueued) &&
            state.stopped === 0 &&
            !changed
          ) {
            if (scenario === 'budget') {
              state.calls--;
              changed = true;
            }
            if (scenario === 'expiry') {
              state.expiresAt++;
              changed = true;
            }
          }
          if (stage === 'commit-release' && scenario === 'release') value.released = false;
          if (scenario === 'outcome' && state.commitQueued && state.stopped === 0) {
            if (stage === 'publication-completed') value.completed = false;
            if (stage === 'cancellation-completed') value.cleanupFinished = false;
          }
          if (scenario === 'reopen' && stage === 'snapshot' && state.stopped === 1 && !changed) {
            state.revision++;
            changed = true;
          }
        },
        undefined,
        'ack-commit'
      );
      f.adapter.bindVerifiedNetworkProof(f.proof);
      await assert.rejects(
        runTransitionPublicationCommit(f.adapter, scenario === 'reopen', transition),
        {
          message: 'n09_transition_commit_driver_failed',
        },
        transition + ':' + scenario
      );
      assert.equal(f.state.closed, 1);
      if (!cancellation && !['budget', 'expiry'].includes(scenario))
        assert.ok(f.state.events.includes('ack-release'));
    }
    if (cancellation) {
      const f = fixture(
        (stage, _value, state) => {
          if (stage === 'prepared-ack-trigger-held') state.observedHttp.reason = 'transport-error';
        },
        undefined,
        'ack-commit'
      );
      f.adapter.bindVerifiedNetworkProof(f.proof);
      await assert.rejects(runTransitionPublicationCommit(f.adapter, true, transition), {
        message: 'n09_transition_commit_driver_failed',
      });
      assert.equal(f.state.events.includes('ack-trigger-release'), false);
      assert.equal(f.state.closed, 1);
    }
  }
});

test('transition COMMIT arming is single-use before its first asynchronous boundary and cannot overlap', async () => {
  const f = fixture(() => {}, undefined, 'ack-commit');
  f.adapter.bindVerifiedNetworkProof(f.proof);
  const owner = await f.adapter.startFreshBusinessHost();
  await f.adapter.seedThroughBusinessHttp(owner);
  await f.adapter.readThroughBusinessHttp(owner);
  const first = f.adapter.beginTransitionCommitHold(owner, 'sending');
  await assert.rejects(f.adapter.beginTransitionCommitHold(owner, 'sending'), bad);
  const held = await first;
  assert.equal(held.prefixArmed, true);
  await f.adapter.killOwnedJob(owner);
  await f.adapter.close();
  assert.equal(f.state.closed, 1);
});

test('transition COMMIT driver rejects invalid action inputs before starting a host and closes its adapter', async () => {
  let started = 0,
    closed = 0,
    hooks = 0;
  const trap = () => {
    hooks++;
    throw Error('private');
  };
  const adapter = {
    startFreshBusinessHost() {
      started++;
      throw Error('not reached');
    },
    close() {
      closed++;
    },
  };
  const invalid = [
    undefined,
    null,
    '',
    0,
    'sending-ack',
    '__proto__',
    'sending\n',
    'x'.repeat(100000),
    new Proxy({}, { get: trap }),
  ];
  for (const transition of invalid)
    await assert.rejects(runTransitionPublicationCommit(adapter, false, transition), {
      message: 'n09_transition_commit_driver_failed',
    });
  for (const kill of [undefined, null, 0, 'false', [], new Proxy({}, { get: trap })])
    await assert.rejects(runTransitionPublicationCommit(adapter, kill, 'sending'), {
      message: 'n09_transition_commit_driver_failed',
    });
  assert.equal(started, 0);
  assert.equal(closed, invalid.length + 6);
  assert.equal(hooks, 0);
});
