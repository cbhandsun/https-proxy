'use strict';

// Synthetic protocol server + real owned daemon HTTP only. No product imports.
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { exact, ack, createResponseHold } = require('../shared/boundary.js');
const { createBusinessClient } = require('../shared/business-client.js');
const { startObservedContinuation } = require('./observed-client.js');
const { createN08PhaseObserver } = require('./phase-observer.js');
const LIST = 'hpm_list_retained_evidence';
const READ = 'hpm_read_retained_evidence';
const MODEL = 'n08-synthetic';
const ORIGINAL_TOOL = Object.freeze({
  type: 'function',
  name: 'n08_original',
  description: 'Synthetic original',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
});
const fail = () => new Error('n08_business_scenario_rejected');
const bytes = (body) => Buffer.from(JSON.stringify(body));
const user = (text) => ({ role: 'user', content: [{ type: 'input_text', text }] });
const textReply = (id, text) => ({
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
});
const ordinaryReply = () => ({
  id: 'n08-ordinary-default',
  object: 'response',
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'N08_ORDINARY_DEFAULT_OK' }],
    },
  ],
});
function parseReply(reply) {
  if (reply.status !== 200 || !Buffer.isBuffer(reply.bytes) || reply.bytes.length > 262144)
    throw fail();
  const text = reply.bytes.toString('utf8');
  if (!Buffer.from(text).equals(reply.bytes)) throw fail();
  const body = JSON.parse(text);
  if (body?.object !== 'response' || body.status !== 'completed' || !Array.isArray(body.output))
    throw fail();
  return body;
}
function toolResult(body, callId) {
  const matching = body.input.filter(
    (item) => item.type === 'function_call_output' && item.call_id === callId
  );
  if (
    matching.length !== 1 ||
    typeof matching[0].output !== 'string' ||
    matching[0].output.length > 131072
  )
    throw fail();
  return JSON.parse(matching[0].output);
}
function createBusinessScenario(input, observer) {
  const onPhase = createN08PhaseObserver(observer);
  const options = exact(input, ['ownedRoot']);
  if (typeof options.ownedRoot !== 'string' || !require('node:path').isAbsolute(options.ownedRoot))
    throw fail();
  const states = new Map();
  const stateFor = (value) => {
    const state = states.get(value.identity.nonce);
    if (!state || state.value !== value) throw fail();
    return state;
  };
  const requestBody = (state, input, extra = {}) => ({
    model: MODEL,
    stream: false,
    instructions: 'Synthetic N08 owner ' + state.nonce,
    tools: [ORIGINAL_TOOL],
    tool_choice: 'auto',
    input,
    ...extra,
  });
  async function send(state, body) {
    const wire = bytes(body);
    const client = createBusinessClient({
      entryPort: state.value.owner.identity.entryPort,
      entryKey: state.entryKey,
      templates: { compact: wire, continuation: wire, ordinary: wire },
    });
    return client('continuation');
  }
  async function config(state, phase = 145) {
    onPhase(phase);
    const reply = await state.value.owner.request({ method: 'GET', route: '/v1/local/config' });
    if (reply.status !== 200 || !reply.body || typeof reply.body._revision !== 'string')
      throw fail();
    return reply.body;
  }
  async function save(state, update, enabled) {
    const before = await config(state);
    // Redacted management GET secrets must never be saved back as credentials.
    const cfg = update({
      ...before,
      profiles: state.profiles.map((profile) => ({ ...profile })),
      entryAuth: {
        enabled: true,
        keys: [{ ...state.key, allowedProfileIds: [...state.key.allowedProfileIds] }],
      },
    });
    onPhase(146);
    const saved = await state.value.owner.request({
      method: 'POST',
      route: '/v1/local/config',
      body: cfg,
    });
    if (saved.status !== 200 || saved.body?.ok !== true || typeof saved.body.revision !== 'string')
      throw fail();
    const after = await config(state, 147);
    let health;
    const deadline = performance.now() + 15000;
    do {
      onPhase(148);
      health = await state.value.owner.request({ method: 'GET', route: '/v1/local/health' });
      if (
        health.status === 200 &&
        health.body?.pid === state.value.owner.identity.pid &&
        health.body.contextRecovery?.appliedEnabled === enabled &&
        health.body.contextRecovery?.storage === (enabled ? 'persistent' : 'memory')
      )
        break;
      if (performance.now() >= deadline || (await state.value.owner.isAlive()) !== true)
        throw fail();
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (performance.now() < deadline);
    if (
      after._revision !== saved.body.revision ||
      after.activeProfile !== cfg.activeProfile ||
      after.appSettings?.contextRecoveryEnabled !== enabled ||
      after.appSettings?.contextRecoveryPersistenceEnabled !== true ||
      after.appSettings?.verifyUpstreamTls !== true ||
      !Array.isArray(after.appSettings?.upstreamDnsServers) ||
      after.appSettings.upstreamDnsServers.length !== 0 ||
      health.status !== 200 ||
      health.body?.pid !== state.value.owner.identity.pid ||
      performance.now() >= deadline ||
      health.body.contextRecovery?.appliedEnabled !== enabled ||
      health.body.contextRecovery?.storage !== (enabled ? 'persistent' : 'memory') ||
      JSON.stringify(after.entryAuth?.keys?.[0]?.allowedProfileIds) !==
        JSON.stringify(state.key.allowedProfileIds) ||
      state.profiles.some(
        (profile) =>
          after.profiles?.find((item) => item.id === profile.id)?.targetUrl !== profile.targetUrl
      )
    )
      throw fail();
    state.revision = after._revision;
  }
  const api = {
    async configureAndSeed(value) {
      const nonce = value.identity.nonce;
      if (states.has(nonce)) throw fail();
      const entryKey = randomBytes(24).toString('hex');
      const state = {
        value,
        nonce,
        entryKey,
        upstreamKey: randomBytes(24).toString('hex'),
        phase: 'configure',
        privateRequests: 0,
        defaultRequests: 0,
        externalToolExecutions: 0,
        ledger: [],
        held: undefined,
        pending: undefined,
      };
      state.key = {
        id: 'n08-' + nonce,
        key: entryKey,
        enabled: true,
        allowedEntryProtocols: ['openai-responses'],
        allowedEntryPorts: [value.owner.identity.entryPort],
        allowedProfileIds: ['n08-default', 'n08-spare'],
      };
      state.profiles = ['n08-default', 'n08-spare'].map((id) => ({
        id,
        name: id,
        protocol: 'openai',
        targetUrl: 'https://api.openai.com/v1',
        apiKey: state.upstreamKey,
        authMode: 'api-key',
      }));
      states.set(nonce, state);
      await save(
        state,
        (cfg) => ({
          ...cfg,
          activeProfile: 'n08-default',
          modelRoutes: [],
          appSettings: {
            ...cfg.appSettings,
            contextRecoveryEnabled: true,
            contextRecoveryPersistenceEnabled: true,
            verifyUpstreamTls: true,
            upstreamDnsServers: [],
            upstreamWarmupEnabled: false,
            conversationAuditEnabled: false,
            conversationAuditCaptureContent: false,
          },
        }),
        true
      );
      const seed = user('N08_SEED ' + nonce);
      state.phase = 'seed-call';
      onPhase(149);
      const first = parseReply(await send(state, requestBody(state, [seed])));
      if (
        first.output.length !== 1 ||
        first.output[0].type !== 'function_call' ||
        first.output[0].name !== 'n08_original' ||
        first.output[0].call_id !== 'n08_original_' + nonce
      )
        throw fail();
      const original = 'N08_PRIVATE_CONTENT ' + nonce + ' ' + 'synthetic-evidence '.repeat(256);
      state.externalToolExecutions++;
      state.history = [
        seed,
        first.output[0],
        { type: 'function_call_output', call_id: first.output[0].call_id, output: original },
      ];
      state.phase = 'seed-output';
      onPhase(150);
      const second = parseReply(await send(state, requestBody(state, state.history)));
      state.history.push(...second.output);
      // Same native local-summary shape observed in v7 and codex-summary tests.
      // The daemon, not this fixture, creates the hcr1 summary receipt.
      state.phase = 'summary';
      onPhase(151);
      const summary = parseReply(
        await send(
          state,
          requestBody(
            state,
            [
              ...state.history,
              user('CONTEXT CHECKPOINT COMPACTION ' + nonce + ' create a handoff summary'),
            ],
            { tools: [], tool_choice: 'auto' }
          )
        )
      );
      const summaryText = summary.output[0]?.content?.[0]?.text;
      if (
        summary.output.length !== 1 ||
        typeof summaryText !== 'string' ||
        !/<!-- hpm-codex-summary:hcr1_[a-f0-9]{48}_[a-f0-9]{64}_[1-9][0-9]{0,6} -->/.test(
          summaryText
        ) ||
        summaryText.includes('N08_PRIVATE_CONTENT')
      )
        throw fail();
      state.continuation = requestBody(state, [user(summaryText), user('N08_RECOVER ' + nonce)]);
      state.ordinary = requestBody(state, [user('N08_ORDINARY ' + nonce)]);
      // Metadata-only reader pins an already-created disk root; never adopts it.
      onPhase(152);
      const { createDurableSnapshotReader } = require('../n09-snapshot/readonly-snapshot.js');
      state.snapshots = createDurableSnapshotReader({
        ownedRoot: options.ownedRoot,
        runtimeDir: value.owner.identity.runtimeDir,
      });
      state.phase = 'ready';
      const templates = {
        compact: bytes(state.continuation),
        continuation: bytes(state.continuation),
        ordinary: bytes(state.ordinary),
      };
      return { entryKey, templates, state };
    },
    async onBusinessRequest(input) {
      const incoming = exact(input, ['path', 'authorization', 'bytes', 'response']);
      if (
        incoming.path !== '/v1/responses' ||
        !Buffer.isBuffer(incoming.bytes) ||
        incoming.bytes.length > 262144
      )
        throw fail();
      const bodyText = incoming.bytes.toString('utf8');
      if (!Buffer.from(bodyText).equals(incoming.bytes)) throw fail();
      const body = JSON.parse(bodyText);
      const matched = [...states.values()].filter(
        (state) => incoming.authorization === 'Bearer ' + state.upstreamKey
      );
      if (matched.length !== 1 || !Array.isArray(body.input)) throw fail();
      const state = matched[0];
      // The credential binds an owner; the fixed instruction binds its nonce.
      if (body.instructions !== 'Synthetic N08 owner ' + state.nonce || body.model !== MODEL)
        throw fail();
      const reply = (output) => {
        if (incoming.response.destroyed || incoming.response.headersSent) throw fail();
        incoming.response.writeHead(200, {
          'content-type': 'application/json',
          connection: 'close',
        });
        incoming.response.end(bytes(output));
      };
      const privateTools =
        Array.isArray(body.tools) && body.tools.some((tool) => [LIST, READ].includes(tool.name));
      const ordinary = body.input.some(
        (item) =>
          item.role === 'user' &&
          item.content?.some?.((block) => block.text === 'N08_ORDINARY ' + state.nonce)
      );
      state.ledger.push(
        Object.freeze({
          ordinal: state.ledger.length + 1,
          phase: state.phase,
          private: privateTools,
          ordinary,
        })
      );
      if (privateTools) state.privateRequests++;
      else if (state.phase === 'mutated' || ordinary) state.defaultRequests++;
      if (ordinary || (state.phase === 'mutated' && !privateTools)) return reply(ordinaryReply());
      if (state.phase === 'seed-call') {
        state.phase = 'seed-call-seen';
        return reply({
          ...textReply('n08-seed-' + state.nonce, ''),
          output: [
            {
              type: 'function_call',
              id: 'fc_' + state.nonce,
              call_id: 'n08_original_' + state.nonce,
              name: 'n08_original',
              arguments: '{}',
            },
          ],
        });
      }
      if (state.phase === 'seed-output')
        return reply(textReply('n08-seeded-' + state.nonce, 'READY'));
      if (state.phase === 'summary')
        return reply(
          textReply(
            'n08-summary-' + state.nonce,
            'Retain the original evidence pointer for owner ' + state.nonce + '.'
          )
        );
      if (state.phase !== 'recovering' || state.held) throw fail();
      const call = (name, args, id) => ({
        ...textReply('n08-private-' + state.nonce, ''),
        output: [
          {
            type: 'function_call',
            id: 'fc_' + id,
            call_id: id,
            name,
            arguments: JSON.stringify(args),
          },
        ],
      });
      const listId = 'n08_list_' + state.nonce;
      const readId = 'n08_read_' + state.nonce;
      let output;
      if (privateTools && !body.input.some((item) => item.call_id === listId))
        return reply(call(LIST, { limit: 1 }, listId));
      if (privateTools && !body.input.some((item) => item.call_id === readId)) {
        const index = toolResult(body, listId);
        const source = index.sources?.[0];
        if (
          index.ok !== true ||
          index.sources.length !== 1 ||
          !/^hce_[a-f0-9]{32}$/.test(source?.sourceId) ||
          !/^[a-f0-9]{64}$/.test(source?.digest)
        )
          throw fail();
        state.source = source;
        output = call(
          READ,
          { sourceId: source.sourceId, digest: source.digest, offsetBytes: 0, limitBytes: 8192 },
          readId
        );
        if (state.value.caseOptions.barrier !== 'read-tool-response') return reply(output);
      } else if (!privateTools) {
        // Isolated public generation must contain the authorized synthetic page.
        if (!bodyText.includes('N08_PRIVATE_CONTENT') || !bodyText.includes(state.nonce))
          throw fail();
        output = textReply('n08-public-' + state.nonce, 'N08_PUBLIC_RESULT ' + state.nonce);
        if (state.value.caseOptions.barrier !== 'public-final-response') throw fail();
      } else {
        const read = toolResult(body, readId);
        if (
          read.ok !== true ||
          typeof read.page?.text !== 'string' ||
          !read.page.text.includes('N08_PRIVATE_CONTENT')
        )
          throw fail();
        return reply(textReply('n08-private-done-' + state.nonce, 'READY'));
      }
      const hold = createResponseHold(
        {
          owner: state.value.identity,
          barrier: state.value.caseOptions.barrier,
          mutation: state.value.caseOptions.mutation,
        },
        {
          deliver: async () => {
            reply(output);
            return true;
          },
          cancel: async () => {
            incoming.response.destroy();
            return true;
          },
        }
      );
      state.held = hold;
      state.heldAck = hold.arrive({
        nonce: state.nonce,
        ordinal: 1,
        readToolCalls: state.value.caseOptions.barrier === 'read-tool-response' ? 1 : 0,
        finalTextItems: state.value.caseOptions.barrier === 'public-final-response' ? 1 : 0,
        publicWrites: state.inflight.bytes(),
      });
      state.resolveHeld?.(state.heldAck);
    },
    async beginRecovery(value) {
      const state = stateFor(value);
      if (state.phase !== 'ready') throw fail();
      state.phase = 'recovering';
      state.inflight = startObservedContinuation({
        entryPort: value.owner.identity.entryPort,
        entryKey: state.entryKey,
        body: bytes(state.continuation),
      });
      state.pending = state.inflight.result;
    },
    async waitUpstreamHold(value) {
      const state = stateFor(value);
      const receipt =
        state.heldAck ||
        (await new Promise((resolve, reject) => {
          state.holdTimer = setTimeout(() => {
            state.resolveHeld = undefined;
            reject(fail());
          }, 10000);
          state.resolveHeld = (receipt) => {
            clearTimeout(state.holdTimer);
            state.resolveHeld = undefined;
            resolve(receipt);
          };
        }));
      state.before = await state.snapshots.read();
      if (
        state.before.present !== true ||
        state.before.evidenceLevel !== 'committed-metadata-only' ||
        state.before.hostDurableAck !== false
      )
        throw fail();
      return receipt;
    },
    async applyMutation(value) {
      const state = stateFor(value);
      if (!state.held || state.phase !== 'recovering') throw fail();
      const mutation = value.caseOptions.mutation;
      if (mutation === 'permission-change') state.key.allowedProfileIds = ['n08-default'];
      if (mutation === 'target-change')
        state.profiles[0].targetUrl = 'https://n08-target.invalid/v1';
      await save(
        state,
        (cfg) => ({
          ...cfg,
          appSettings: { ...cfg.appSettings, contextRecoveryEnabled: mutation !== 'disable' },
        }),
        mutation !== 'disable'
      );
      state.phase = 'mutated';
      state.privateAtMutation = state.privateRequests;
      state.defaultAtMutation = state.defaultRequests;
      const receipt = ack(value.identity, value.caseOptions.barrier, mutation, 'mutation-applied');
      state.held.mutationApplied(receipt);
      return receipt;
    },
    async probeAdmissions(value) {
      const state = stateFor(value);
      if (state.phase !== 'mutated') throw fail();
      const beforePrivate = state.privateRequests,
        beforeDefault = state.defaultRequests;
      const enhanced = await value.client('continuation');
      const afterEnhanced = state.defaultRequests;
      const ordinary = await value.client('ordinary');
      state.defaultAfterAdmissions = state.defaultRequests;
      return {
        enhanced,
        ordinary,
        enhancedPrivateDispatchDelta: state.privateRequests - beforePrivate,
        oldRootPrivateRequestDelta: state.privateRequests - state.privateAtMutation,
        enhancedDefaultDispatchDelta: afterEnhanced - beforeDefault,
        ordinaryDefaultDispatchDelta: state.defaultRequests - afterEnhanced,
      };
    },
    releaseUpstreamHold: (value) => stateFor(value).held.release(),
    async observeWithdrawal(value) {
      const state = stateFor(value);
      const settled = await state.pending;
      state.settled = settled;
      const after = await state.snapshots.read();
      if (
        settled.failed ||
        after.present !== true ||
        after.evidenceLevel !== 'committed-metadata-only' ||
        after.hostDurableAck !== false
      ) {
        // Absence after revocation cannot fabricate same-owner counters.
        throw new Error('n08_durable_same_owner_snapshot_unavailable');
      }
      const snapshot = (source) => ({
        rootId: source.rootId,
        expiresAt: source.expiresAt,
        readerCalls: source.calls,
        readerBytes: source.returnedBytes,
      });
      return {
        response: settled.response,
        externalToolReplays: Math.max(0, state.externalToolExecutions - 1),
        oldRootPrivateRequestDelta: state.privateRequests - state.privateAtMutation,
        inFlightDefaultDispatchDelta:
          settled.response.status === 200
            ? state.defaultRequests - state.defaultAfterAdmissions
            : 0,
        before: snapshot(state.before),
        after: snapshot(after),
      };
    },
    async cancelUpstream(value) {
      const state = stateFor(value);
      clearTimeout(state.holdTimer);
      state.resolveHeld = undefined;
      if (state.held) await state.held.cancel();
      if (state.inflight) state.inflight.cancel();
      if (state.snapshots) await state.snapshots.close();
      states.delete(state.nonce);
      return true;
    },
  };
  return Object.freeze(api);
}
module.exports = { createBusinessScenario, parseReply };
