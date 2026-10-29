'use strict';

const net = require('node:net');
const { dataSnapshot, callable, settle } = require('./context-recovery-daemon-http-boundary');
const { parseDrainOptions, drainPlan, INPUT } = require('./nsis-installed-drain-wire');
const { startDrainResponse } = require('./nsis-installed-drain-response');
const { createInstalledWebSocketDrain } = require('./nsis-installed-websocket-drain');
const diagnostics = new WeakMap();
const PHASES = Object.freeze([
  'options',
  'owner',
  'upstream_hold',
  'websocket_open',
  'websocket_close',
  'listener_stop',
  'public_response',
  'natural_exit',
  'storage',
  'cleanup',
]);
const fail = (phase) => {
  const error = new Error('installed_http_drain_failed');
  if (PHASES.includes(phase)) diagnostics.set(error, phase);
  return error;
};

// This is a runner-local acceptance capability, with no argv entry. The caller
// owns and attests the installed daemon and isolated synthetic TLS upstream.
// A TCP refusal proves listener stop began; 202 alone cannot release the hold.
async function exerciseInstalledTransportDrain(
  input,
  { owner, adapter, active, observe },
  withSse,
  withWebSocket = false
) {
  let options, timer, natural, probe, previous, release, websocket, websocketDrain;
  const requests = [];
  let phase = 'options',
    failedPhase;
  let failed = false,
    result,
    released = false,
    calls = 0,
    responseFinished = false;
  const sockets = new Set();
  let rejectDeadline;
  const deadline = new Promise((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const within = (pending) => Promise.race([pending, deadline]);
  try {
    options = parseDrainOptions(input);
    phase = 'owner';
    const port = owner.identity.entryPort;
    if (
      !Number.isSafeInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      !callable(observe) ||
      adapter.verifyOwnedIdentity(owner) !== true ||
      (await settle(owner.isAlive(), 'installed_http_drain_failed')).value !== true ||
      !active.current ||
      active.current.client !== options.client ||
      active.current.mode !== options.mode ||
      active.current.upstreamToken !== options.upstreamToken
    )
      throw fail();
    const plans = [drainPlan(options, false), ...(withSse ? [drainPlan(options, true)] : [])];
    const seen = new Set();
    let prefixSeen = false,
      prefixWritten = false;
    let acceptPrefix;
    const prefixReceived = new Promise((resolve) => {
      acceptPrefix = resolve;
    });
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    let entered;
    const held = new Promise((resolve) => {
      entered = resolve;
    });
    previous = active.current;
    if (withWebSocket && options.client === 'codex')
      websocket = createInstalledWebSocketDrain(options);
    // Each request still performs its original observation. The installed
    // observer owns one exact-sequence mailbox, so concurrent probes must not
    // write it concurrently. A failed observation poisons this queue; no retry.
    let observationTail = Promise.resolve();
    const observeInOrder = () => {
      const next = observationTail
        .then(() => settle(observe(), 'installed_http_drain_failed'))
        .then(() => true);
      observationTail = next;
      return next;
    };
    probe = {
      client: options.client,
      mode: options.mode,
      upstreamToken: options.upstreamToken,
      observe: observeInOrder,
      ...(websocket ? { prepareUpgrade: websocket.prepare } : {}),
      upstream: {
        respond({ body }) {
          if (
            ++calls > plans.length ||
            body.model !== options.model ||
            typeof body.stream !== 'boolean' ||
            seen.has(body.stream) ||
            (!withSse && body.stream) ||
            !JSON.stringify(options.client === 'codex' ? body.input : body.messages).includes(INPUT)
          )
            throw fail();
          seen.add(body.stream);
          return plans.find((plan) => plan.stream === body.stream).reply;
        },
      },
      beforeReply(reply) {
        if (reply.stream === true) return true;
        entered();
        return hold;
      },
      ...(withSse
        ? {
            prefixBytes: plans[1].split,
            afterPrefix() {
              prefixWritten = true;
              return hold;
            },
          }
        : {}),
    };
    active.current = probe;
    timer = setTimeout(() => {
      rejectDeadline(fail());
      for (const request of requests) request.destroy();
      for (const socket of sockets) socket.destroy();
      release(false);
    }, 5000);
    const responses = plans.map((plan) =>
      startDrainResponse({
        port,
        options,
        plan,
        isReleased: () => released,
        onPrefix: () => {
          prefixSeen = true;
          acceptPrefix();
        },
        onFinished: () => {
          responseFinished = true;
        },
        onRequest: (request) => requests.push(request),
      })
    );
    const response = Promise.all(responses);
    // Attach rejection handlers before waiting for the held upstream. These
    // handlers only prevent unhandled rejection; every verdict is still awaited.
    void response.catch(() => {});
    phase = websocket ? 'websocket_open' : 'upstream_hold';
    await within(
      Promise.race([
        Promise.all([
          held,
          ...(withSse ? [prefixReceived] : []),
          ...(websocket ? [websocket.open(port)] : []),
        ]),
        response.then(() => {
          throw fail();
        }),
      ])
    );
    if (websocket && options.mode === 'default') await within(observeInOrder());
    if (
      calls !== plans.length ||
      responseFinished ||
      active.current !== probe ||
      (withSse && (!prefixSeen || !prefixWritten))
    )
      throw fail();
    websocket?.beginStop();
    natural = settle(owner.stopNaturally(), 'installed_http_drain_failed').then(({ value }) => {
      if (!released) throw fail();
      return dataSnapshot(value, 'installed_http_drain_failed');
    });
    void natural.catch(() => {});
    phase = 'listener_stop';
    for (;;) {
      const closed = await within(
        new Promise((resolve, reject) => {
          let refusal = false,
            invalid = false;
          const socket = net.createConnection({ host: '127.0.0.1', port });
          sockets.add(socket);
          socket.once('connect', () => socket.destroy());
          socket.once('error', (error) => {
            refusal = error.code === 'ECONNREFUSED';
            invalid = !refusal;
          });
          socket.once('close', () => {
            sockets.delete(socket);
            invalid ? reject(fail()) : resolve(refusal);
          });
        })
      );
      if (responseFinished || active.current !== probe) throw fail();
      if (closed) break;
      await within(new Promise((resolve) => setTimeout(resolve, 10)));
    }
    phase = 'public_response';
    released = true;
    release(true);
    if ((await within(response)).some((value) => value !== true)) throw fail();
    if (websocket) {
      phase = 'websocket_close';
      websocketDrain = await within(websocket.verifyClosed());
    }
    clearTimeout(timer);
    phase = 'natural_exit';
    const exited = await natural;
    if (
      Object.keys(exited).sort().join(',') !== 'cleanupSemantics,exitCode,treeEmpty' ||
      exited.cleanupSemantics !== 'natural_exit' ||
      exited.exitCode !== 0 ||
      exited.treeEmpty !== true
    )
      throw fail();
    phase = 'storage';
    const stored = dataSnapshot(owner.inspectStorage(), 'installed_http_drain_failed');
    if (
      stored.allWithinRoot !== true ||
      ['directoryPresent', 'checkpointPresent', 'writerDatabasePresent', 'wrappedKeyPresent'].some(
        (key) => stored[key] !== (options.mode === 'enhanced')
      )
    )
      throw fail();
    result = {
      ...exited,
      httpTransportDrainQualified: true,
      ...(withSse ? { sseTransportDrainQualified: true } : {}),
      ...(websocket ? { websocketDrainQualified: true, websocketDrain } : {}),
    };
  } catch {
    failed = true;
    failedPhase = phase;
  } finally {
    clearTimeout(timer);
    release?.(false);
    for (const request of requests) request.destroy();
    for (const socket of sockets) socket.destroy();
    if (websocket) {
      try {
        await websocket.close();
      } catch {
        failed = true;
      }
    }
    if (probe && active.current === probe) active.current = previous;
    else if (probe) failed = true;
    if (natural) {
      try {
        await natural;
      } catch {
        failed = true;
      }
    }
  }
  if (failed || !result) throw fail(failedPhase ?? 'cleanup');
  return result;
}

module.exports = {
  HTTP_DRAIN_PHASES: PHASES,
  exerciseInstalledHttpDrain: (input, deps) => exerciseInstalledTransportDrain(input, deps, false),
  exerciseInstalledHttpSseDrain: (input, deps) =>
    exerciseInstalledTransportDrain(input, deps, true),
  exerciseInstalledHttpSseWebSocketDrain: (input, deps) =>
    exerciseInstalledTransportDrain(input, deps, true, true),
  parseDrainOptions,
  httpDrainFailurePhase: (error) => diagnostics.get(error) ?? null,
};
