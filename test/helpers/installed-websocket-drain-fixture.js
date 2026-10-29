'use strict';

const http = require('node:http');
const { once } = require('node:events');
const {
  attachInstalledWebSocketListener,
} = require('../../scripts/lib/nsis-installed-websocket-listener');
const { createWebSocketProxy } = require('../../lib/proxy/websocket-proxy');
const { createStoppingAdmission } = require('../../lib/proxy/stopping-admission');
const { createContextRecoverySessions } = require('../../lib/proxy/context-recovery-sessions');

// Real local WS proxy and recovery transport, memory session only. Synthetic
// SNI and provider seam cannot confer TLS/DPAPI/installed Windows qualification.
async function installWebSocketDrainFixture(t, entry, options, active, fault) {
  const upstream = http.createServer();
  const sockets = new Set();
  upstream.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  upstream.on('upgrade', (request) => {
    request.socket.servername = 'api.openai.com';
  });
  const lease = attachInstalledWebSocketListener(upstream, (event) => {
    if (fault === 'ws-auth') event = { ...event, authorization: 'invalid-synthetic' };
    const handler = active.current.prepareUpgrade(event);
    return (peer) => {
      if (fault === 'ws-early') {
        peer.close();
        return;
      }
      if (['ws-frame', 'ws-terminal', 'ws-binary', 'ws-utf8', 'ws-oversized'].includes(fault)) {
        const send = peer.send.bind(peer);
        peer.send = (bytes, ...rest) => {
          if (fault === 'ws-utf8') return send(Buffer.from([255]), { binary: false }, rest.at(-1));
          if (fault === 'ws-binary') return send(bytes, { binary: true }, rest.at(-1));
          const parsed = JSON.parse(bytes);
          if (fault === 'ws-frame' && parsed.type === 'response.output_text.delta')
            parsed.delta = 'wrong-synthetic';
          if (fault === 'ws-terminal' && parsed.type === 'response.output_text.delta')
            parsed.type = 'response.completed';
          if (fault === 'ws-oversized') parsed.syntheticPadding = 'x'.repeat(5000);
          return send(JSON.stringify(parsed), ...rest);
        };
      }
      return handler(peer);
    };
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const sessions = createContextRecoverySessions();
  sessions.configure(options.mode === 'enhanced');
  const config = {
    appSettings: { contextRecoveryEnabled: options.mode === 'enhanced' },
    entryAuth: {
      enabled: fault !== 'ws-auth-bypass',
      keys: [{ id: 'synthetic-installed-owner', key: options.entryToken, enabled: true }],
    },
  };
  const profile = {
    id: 'synthetic-installed-profile',
    protocol: 'openai',
    authMode: 'api-key',
    apiKey: options.upstreamToken,
    targetUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1',
  };
  const priorKey = process.env.API_KEY;
  delete process.env.API_KEY;
  t.after(() => {
    if (priorKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = priorKey;
  });
  const handleUpgrade = createWebSocketProxy({
    getConfig: () => config,
    getProfiles: () => [profile],
    getActiveProfile: () => profile,
    contextRecoveryLifecycle: { sessions },
    recoveryProviderAllowed: () => true,
  });
  let stopping = false;
  const admission = createStoppingAdmission({
    isStopping: () => stopping,
    handleRequest() {},
    handleUpgrade,
  });
  entry.on('upgrade', (request, socket, head) => {
    void admission.upgrade(request, socket, head, {
      protocol: 'openai-responses',
      listenPort: entry.address().port,
    });
  });
  return {
    stop() {
      stopping = true;
      return fault === 'ws-not-closed' ? Promise.resolve(true) : admission.closeUpgrades();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await lease.close();
      await new Promise((resolve) => upstream.close(resolve));
      await sessions.shutdownAsync();
      if (sockets.size) throw Error('synthetic_ws_cleanup_failed');
    },
  };
}
module.exports = { installWebSocketDrainFixture };
