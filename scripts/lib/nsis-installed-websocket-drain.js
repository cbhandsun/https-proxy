'use strict';

const { WebSocket } = require('ws');
const { isDeepStrictEqual } = require('node:util');
const { parseDrainOptions } = require('./nsis-installed-drain-wire');
const { syntheticCodexWire } = require('./nsis-client-codex-upstream-wire');
const { createSseJsonDecoder } = require('../../lib/proxy/forced-stream-collector');
const { exact } = require('../context-hosted/shared/boundary');
const { startInstalledWebSocketRefusal } = require('./nsis-installed-websocket-auth');
const fail = () => new Error('installed_websocket_drain_failed');
const INPUT = 'HPM_INSTALLED_WS_DRAIN_REQUEST';
const STREAM = 'hpm_installed_ws_drain';

function prefix(options) {
  const events = [];
  const decoder = createSseJsonDecoder(4096, (event) =>
    events.push({ ...event, stream_id: STREAM })
  );
  decoder.push(
    syntheticCodexWire({
      model: options.model,
      sequence: 914,
      text: 'HPM_INSTALLED_WS_PENDING',
      stream: true,
    }).wire
  );
  decoder.finish();
  const end = events.findIndex((event) => event.type === 'response.output_text.delta');
  if (end !== 4) throw fail();
  return events.slice(0, end + 1);
}
function parse(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 4096) throw fail();
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

// One ordinary Responses turn stays incomplete, with its exact public prefix
// observed at the actual entry. No response.completed is sent or accepted.
// The caller's original five-second gate owns opening and natural shutdown.
function createInstalledWebSocketDrain(input) {
  const options = parseDrainOptions(input);
  if (options.client !== 'codex') throw fail();
  const events = prefix(options);
  let refusal,
    refused = false;
  let client,
    peer,
    opening,
    cleanup,
    stopped = false,
    bad = false,
    verified = false;
  let readyComplete = false;
  let handshakes = 0,
    requests = 0,
    received = 0,
    clientClosed = false,
    peerClosed = false;
  let resolveReady, rejectReady, resolveHeld, resolveClientClose, resolvePeerClose;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  const held = new Promise((resolve) => {
    resolveHeld = resolve;
  });
  const clientEnd = new Promise((resolve) => {
    resolveClientClose = resolve;
  });
  const peerEnd = new Promise((resolve) => {
    resolvePeerClose = resolve;
  });
  function reject() {
    bad = true;
    rejectReady(fail());
    client?.terminate();
    peer?.terminate();
  }
  return Object.freeze({
    prepare(input) {
      let event;
      try {
        event = exact(input, ['path', 'authorization']);
      } catch {
        reject();
        throw fail();
      }
      if (
        cleanup ||
        stopped ||
        bad ||
        ++handshakes !== 1 ||
        event.path !== '/v1/responses' ||
        event.authorization !== 'Bearer ' + options.upstreamToken
      ) {
        reject();
        throw fail();
      }
      return async (owned) => {
        peer = owned;
        peer.on('error', reject);
        peer.once('close', () => {
          peerClosed = true;
          resolvePeerClose();
          if (!stopped) reject();
        });
        const body = await new Promise((resolve, refuse) => {
          peer.on('message', (bytes, binary) => {
            try {
              const value = parse(bytes);
              if (
                binary ||
                ++requests !== 1 ||
                value.type !== 'response.create' ||
                value.model !== options.model ||
                value.stream_id !== STREAM ||
                !JSON.stringify(value.input).includes(INPUT)
              )
                throw fail();
              resolve(value);
            } catch {
              reject();
              refuse(fail());
            }
          });
          peer.once('close', () => refuse(fail()));
        });
        if (!body || bad) throw fail();
        // The first listener also rejects duplicates in the same received batch.
        for (const event of events)
          await new Promise((resolve, refuse) => {
            peer.send(JSON.stringify(event), { binary: false }, (error) =>
              error ? refuse(fail()) : resolve()
            );
          });
        resolveHeld();
        await peerEnd;
        if (bad || !stopped) throw fail();
      };
    },
    open(port) {
      if (opening || cleanup || !Number.isSafeInteger(port) || port < 1024 || port > 65535)
        return Promise.reject(fail());
      opening = Promise.resolve().then(async () => {
        refusal = startInstalledWebSocketRefusal(port, options.model);
        await refusal.result;
        if (bad || cleanup || handshakes !== 0) throw fail();
        refused = true;
        client = new WebSocket('ws://127.0.0.1:' + port + '/v1/responses', {
          followRedirects: false,
          perMessageDeflate: false,
          maxPayload: 4096,
          handshakeTimeout: 5000,
          headers: {
            authorization: 'Bearer ' + options.entryToken,
            'x-codex-routing-hint': 'model=' + options.model,
          },
        });
        client.on('error', reject);
        client.once('close', () => {
          clientClosed = true;
          resolveClientClose();
          if (!stopped) reject();
        });
        client.once('unexpected-response', (_request, response) => {
          response.destroy();
          reject();
        });
        client.once('open', () =>
          client.send(
            JSON.stringify({
              type: 'response.create',
              model: options.model,
              stream_id: STREAM,
              input: [{ role: 'user', content: INPUT }],
            }),
            { binary: false },
            (error) => {
              if (error) reject();
            }
          )
        );
        client.on('message', (bytes, binary) => {
          try {
            if (
              binary ||
              received >= events.length ||
              !isDeepStrictEqual(parse(bytes), events[received++])
            )
              throw fail();
            if (received === events.length) resolveReady();
          } catch {
            reject();
          }
        });
        await Promise.all([ready, held]);
        if (
          bad ||
          clientClosed ||
          peerClosed ||
          handshakes !== 1 ||
          requests !== 1 ||
          received !== events.length
        )
          throw fail();
        readyComplete = true;
      });
      return opening;
    },
    beginStop() {
      if (
        bad ||
        cleanup ||
        stopped ||
        !readyComplete ||
        !refused ||
        received !== events.length ||
        clientClosed ||
        peerClosed ||
        handshakes !== 1 ||
        requests !== 1
      )
        throw fail();
      stopped = true;
    },
    async verifyClosed() {
      if (!stopped || !readyComplete || cleanup || bad) throw fail();
      await Promise.all([clientEnd, peerEnd]);
      if (
        bad ||
        cleanup ||
        !stopped ||
        !clientClosed ||
        !peerClosed ||
        received !== events.length ||
        handshakes !== 1 ||
        requests !== 1
      )
        throw fail();
      verified = true;
      return parseInstalledWebSocketDrainEvidence({
        unauthorizedUpgradeRefused: refused,
        protocol: 'responses',
        partialFrames: received,
        terminalFrames: 0,
        clientClosed,
        upstreamClosed: peerClosed,
      });
    },
    close() {
      if (cleanup) return cleanup;
      if (!verified) bad = true;
      client?.terminate();
      peer?.terminate();
      cleanup = Promise.all([
        ...(refusal ? [refusal.close()] : []),
        ...(client ? [clientEnd] : []),
        ...(peer ? [peerEnd] : []),
      ]).then(() => true);
      return cleanup;
    },
  });
}
function parseInstalledWebSocketDrainEvidence(input) {
  const value = exact(input, [
    'protocol',
    'unauthorizedUpgradeRefused',
    'partialFrames',
    'terminalFrames',
    'clientClosed',
    'upstreamClosed',
  ]);
  if (
    value.unauthorizedUpgradeRefused !== true ||
    value.protocol !== 'responses' ||
    value.partialFrames !== 5 ||
    value.terminalFrames !== 0 ||
    value.clientClosed !== true ||
    value.upstreamClosed !== true
  )
    throw fail();
  return Object.freeze({ ...value });
}
module.exports = { createInstalledWebSocketDrain, parseInstalledWebSocketDrainEvidence };
