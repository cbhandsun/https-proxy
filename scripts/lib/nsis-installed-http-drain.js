'use strict';

const http = require('node:http');
const net = require('node:net');
const { isDeepStrictEqual } = require('node:util');
const { dataSnapshot, callable, settle } = require('./context-recovery-daemon-http-boundary');
const diagnostics = new WeakMap();
const PHASES = Object.freeze([
  'options',
  'owner',
  'upstream_hold',
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
const TEXT = 'HPM_INSTALLED_HTTP_DRAIN_OK';
const INPUT = 'HPM_INSTALLED_HTTP_DRAIN_REQUEST';

function parseDrainOptions(input) {
  try {
    const value = dataSnapshot(input, 'installed_http_drain_failed');
    if (
      Object.keys(value).sort().join(',') !== 'client,entryToken,mode,model,upstreamToken' ||
      !['codex', 'claude'].includes(value.client) ||
      !['default', 'enhanced'].includes(value.mode) ||
      value.model !== 'hpm-installed-' + value.client ||
      typeof value.entryToken !== 'string' ||
      !/^hpm-synthetic-[a-f0-9]{32}$/.test(value.entryToken) ||
      typeof value.upstreamToken !== 'string' ||
      !/^hpm-upstream-[a-f0-9]{32}$/.test(value.upstreamToken)
    )
      throw fail();
    return value;
  } catch {
    throw fail();
  }
}

function publicReply(client, model) {
  return client === 'codex'
    ? {
        id: 'resp_hpm_installed_drain',
        object: 'response',
        status: 'completed',
        model,
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: TEXT }] },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }
    : {
        id: 'msg_hpm_installed_drain',
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: TEXT }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
}

// This is a runner-local acceptance capability, with no argv entry. The caller
// owns and attests the installed daemon and isolated synthetic TLS upstream.
// A TCP refusal proves listener stop began; 202 alone cannot release the hold.
async function exerciseInstalledHttpDrain(input, { owner, adapter, active, observe }) {
  let options, request, timer, natural, probe, previous, release;
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
    const expected = publicReply(options.client, options.model);
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    let entered;
    const held = new Promise((resolve) => {
      entered = resolve;
    });
    previous = active.current;
    probe = {
      client: options.client,
      mode: options.mode,
      upstreamToken: options.upstreamToken,
      observe,
      upstream: {
        respond({ body }) {
          if (
            ++calls !== 1 ||
            body.model !== options.model ||
            body.stream !== false ||
            !JSON.stringify(options.client === 'codex' ? body.input : body.messages).includes(INPUT)
          )
            throw fail();
          return {
            statusCode: 200,
            contentType: 'application/json; charset=utf-8',
            wire: Buffer.from(JSON.stringify(expected)),
          };
        },
      },
      beforeReply() {
        entered();
        return hold;
      },
    };
    active.current = probe;
    const body = Buffer.from(
      JSON.stringify(
        options.client === 'codex'
          ? {
              model: options.model,
              input: [{ role: 'user', content: INPUT }],
              stream: false,
            }
          : {
              model: options.model,
              messages: [{ role: 'user', content: INPUT }],
              max_tokens: 32,
              stream: false,
            }
      )
    );
    timer = setTimeout(() => {
      rejectDeadline(fail());
      request?.destroy();
      for (const socket of sockets) socket.destroy();
      release(false);
    }, 5000);
    const response = new Promise((resolve, reject) => {
      request = http.request(
        {
          hostname: '127.0.0.1',
          port,
          agent: false,
          method: 'POST',
          path: options.client === 'codex' ? '/v1/responses' : '/v1/messages',
          headers: {
            'content-type': 'application/json',
            'content-length': body.length,
            authorization: 'Bearer ' + options.entryToken,
          },
        },
        (incoming) => {
          const chunks = [];
          let size = 0;
          incoming.on('error', () => reject(fail()));
          incoming.on('aborted', () => reject(fail()));
          incoming.on('data', (chunk) => {
            size += chunk.length;
            if (size > 65536) {
              incoming.destroy();
              reject(fail());
            } else chunks.push(chunk);
          });
          incoming.once('end', () => {
            responseFinished = true;
            try {
              if (
                !released ||
                incoming.statusCode !== 200 ||
                typeof incoming.headers['content-type'] !== 'string' ||
                incoming.headers['content-type'].split(';')[0].trim().toLowerCase() !==
                  'application/json' ||
                !isDeepStrictEqual(
                  JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
                  ),
                  expected
                )
              )
                throw fail();
              resolve(true);
            } catch {
              reject(fail());
            }
          });
        }
      );
      request.on('error', () => reject(fail()));
      request.end(body);
    });
    // Attach rejection handlers before waiting for the held upstream. These
    // handlers only prevent unhandled rejection; every verdict is still awaited.
    void response.catch(() => {});
    phase = 'upstream_hold';
    await within(
      Promise.race([
        held,
        response.then(() => {
          throw fail();
        }),
      ])
    );
    if (calls !== 1 || responseFinished || active.current !== probe) throw fail();
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
    if ((await within(response)) !== true) throw fail();
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
    result = { ...exited, httpTransportDrainQualified: true };
  } catch {
    failed = true;
    failedPhase = phase;
  } finally {
    clearTimeout(timer);
    release?.(false);
    request?.destroy();
    for (const socket of sockets) socket.destroy();
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
  exerciseInstalledHttpDrain,
  parseDrainOptions,
  httpDrainFailurePhase: (error) => diagnostics.get(error) ?? null,
};
