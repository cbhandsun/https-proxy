'use strict';

const { types } = require('node:util');
const { fields, createCodexSyntheticSource, prepareCase } = require('./nsis-client-codex-options');
const { createNativeLoopbackRpc } = require('./native-loopback-rpc');
const fail = () =>
  Object.assign(new Error('nsis_client_codex_failed'), { code: 'nsis_client_codex_failed' });
const TOOL = 'hpm_fixture_original';
const privateWire =
  /hpm_list_retained_evidence|hpm_read_retained_evidence|private-thinking-sentinel/;
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
// spawnOwned is a trusted Job/WFP capability, not an executable selector. It
// must own partial-start cleanup if it throws before returning {child, stop}.
// This module proves CLI protocol only; upstream READ/publication, installed
// identity and actual egress containment remain the enclosing harness's gates.
async function runInstalledCodexCase(input) {
  let stop,
    rpc,
    verifyOwned,
    stopping = false,
    rpcClosed = false,
    failed = false,
    receipt;
  try {
    const { options, source, root, verify, launch } = prepareCase(input);
    verifyOwned = verify;
    let phase = 'prepare',
      sourceCalls = 0,
      compactions = 0,
      completedTurns = 0,
      sourceTurnId,
      sourceCallId,
      ownedLaunches = 0;
    const compactionIds = new Set(),
      turnIds = new Set();
    const progress = (next) => {
      verify();
      phase = next;
      if (options.onProgress && options.onProgress({ phase }) !== undefined) throw fail();
    };
    let transportFailed = false;
    async function connect() {
      ownedLaunches++;
      const handle = fields(await options.spawnOwned(launch), ['child', 'stop']);
      if (typeof handle.stop !== 'function' || types.isProxy(handle.stop)) throw fail();
      stop = handle.stop;
      const child = handle.child;
      if (
        !child ||
        typeof child.on !== 'function' ||
        !child.stdin ||
        !child.stdout ||
        !child.stderr
      )
        throw fail();
      transportFailed = false;
      rpc = createNativeLoopbackRpc(child, {
        onFailure(code) {
          transportFailed = true;
          if (
            !rpcClosed &&
            (!stopping || !['native_process_exited', 'native_rpc_stream_closed'].includes(code))
          )
            failed = true;
        },
        onNotification(event) {
          if (privateWire.test(JSON.stringify(event))) throw fail();
          if (
            event.method === 'turn/completed' &&
            (!id(threadId) || event.params?.threadId !== threadId)
          )
            throw fail();
          if (event.method !== 'item/completed' || event.params?.item?.type !== 'contextCompaction')
            return;
          const item = event.params.item;
          if (
            !/^compact-[1-3]$/.test(phase) ||
            event.params.threadId !== threadId ||
            !id(item.id) ||
            compactionIds.has(item.id)
          )
            throw fail();
          compactionIds.add(item.id);
          compactions++;
        },
        onServerRequest(message) {
          const params = message.params;
          let args = params?.arguments;
          if (typeof args === 'string') {
            if (args.length > 64) throw fail();
            args = JSON.parse(args);
          }
          fields(args, []);
          if (
            message.method !== 'item/tool/call' ||
            phase !== 'seed' ||
            params.threadId !== threadId ||
            params.tool !== TOOL ||
            (params.namespace !== undefined && params.namespace !== null) ||
            !id(params.turnId) ||
            !id(params.callId) ||
            sourceCalls !== 0
          )
            throw fail();
          sourceTurnId = params.turnId;
          sourceCallId = params.callId;
          sourceCalls++;
          return { success: true, contentItems: [{ type: 'inputText', text: source.text }] };
        },
      });
      await rpc.call('initialize', {
        clientInfo: { name: 'hpm_nsis_offline_codex', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
      rpc.notify('initialized');
    }
    await connect();
    const started = await rpc.call('thread/start', {
      ephemeral: options.restartClient ? false : true,
      cwd: root,
      model: options.model,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      baseInstructions:
        'Synthetic offline task. Only invoke hpm_fixture_original when explicitly asked. Preserve a pointer, never copy its payload or REQUIRED_MARKER in summaries. Do not use shell, files, network or other tools.',
      dynamicTools: [
        {
          type: 'function',
          name: TOOL,
          description: 'Return owned synthetic original exactly once.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    });
    const threadId = started?.thread?.id;
    if (!id(threadId) || (options.restartClient && started.thread.ephemeral !== false))
      throw fail();
    async function turn(nextPhase, text) {
      progress(nextPhase);
      const count = compactions;
      const completed = rpc.waitFor(
        'turn/completed',
        (value) => value.threadId === threadId,
        60000
      );
      void completed.catch(() => {});
      const result = await rpc.call(
        text === null ? 'thread/compact/start' : 'turn/start',
        text === null
          ? { threadId }
          : { threadId, input: [{ type: 'text', text, text_elements: [] }] }
      );
      const done = await completed;
      if (
        transportFailed ||
        done.turn?.status !== 'completed' ||
        !id(done.turn.id) ||
        turnIds.has(done.turn.id) ||
        (text !== null && result?.turn?.id !== done.turn.id) ||
        (text === null && compactions !== count + 1)
      )
        throw fail();
      if (
        nextPhase === 'seed' &&
        (sourceCalls !== 1 || sourceTurnId !== done.turn.id || !sourceCallId)
      )
        throw fail();
      turnIds.add(done.turn.id);
      completedTurns++;
      verify();
      return done.turn;
    }
    await turn(
      'seed',
      'Call hpm_fixture_original exactly once with {}. Reply only READY without quoting its contents.'
    );
    for (let index = 1; index <= 3; index++) await turn('compact-' + index, null);
    if (options.restartClient) {
      // The old process and its owned tree must end before a new transport is
      // constructed. Only a disk-backed thread ID crosses the restart; never
      // supply history, transcript bytes, or a rollout path to resume.
      phase = 'restarting';
      if (failed || transportFailed) throw fail();
      stopping = true;
      const closeFirst = stop;
      stop = undefined;
      const stopped = fields(await closeFirst(), ['terminal', 'treeStopped']);
      if (stopped.terminal !== true || stopped.treeStopped !== true) throw fail();
      verify();
      rpcClosed = true;
      rpc.close();
      rpc = undefined;
      if (failed) throw fail();
      rpcClosed = false;
      stopping = false;
      await connect();
      const resumed = await rpc.call('thread/resume', { threadId });
      if (
        resumed?.thread?.id !== threadId ||
        resumed.thread.ephemeral !== false ||
        ownedLaunches !== 2
      )
        throw fail();
    }
    const final = await turn(
      'final',
      options.mode === 'default'
        ? 'Reply only DONE. Do not invoke any tools.'
        : 'Recover the retained original evidence without rerunning hpm_fixture_original. Follow retained evidence pages until nextOffsetBytes is null. Return only the exact REQUIRED_MARKER value.'
    );
    const expected = options.mode === 'default' ? 'DONE' : source.marker;
    if (!Array.isArray(final.items)) throw fail();
    const publicText = [];
    for (const item of final.items) {
      if (item?.type === 'agentMessage' && typeof item.text === 'string')
        publicText.push(item.text);
      else if (item?.type !== 'reasoning') throw fail();
    }
    if (
      publicText.join('\n').trim() !== expected ||
      compactions !== 3 ||
      sourceCalls !== 1 ||
      transportFailed
    )
      throw fail();
    receipt = {
      schemaVersion: options.restartClient ? 2 : 1,
      scope: 'owned_codex_cli_protocol',
      mode: options.mode,
      completedTurns,
      compactions,
      compactionItems: compactionIds.size,
      sourceCalls,
      exactFinalAnswer: true,
      privateWireLeak: false,
      directModelRequests: 0,
      installedRuntimeQualified: false,
      upstreamRecoveryQualified: false,
      ...(options.restartClient
        ? { clientRestarted: true, persistedThreadResumed: true, ownedLaunches }
        : {}),
    };
  } catch {
    failed = true;
  } finally {
    stopping = true;
    if (stop) {
      try {
        const stopped = fields(await stop(), ['terminal', 'treeStopped']);
        if (stopped.terminal !== true || stopped.treeStopped !== true) failed = true;
      } catch {
        failed = true;
      }
    }
    try {
      verifyOwned?.();
    } catch {
      failed = true;
    }
    rpcClosed = true;
    rpc?.close();
  }
  if (failed || !receipt) throw fail();
  return Object.freeze({ ...receipt, processTerminal: true, ownedTreeStopped: true });
}

module.exports = { createCodexSyntheticSource, runInstalledCodexCase };
