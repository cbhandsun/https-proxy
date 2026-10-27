'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const net = require('node:net');
const { types } = require('node:util');
const { exact } = require('./boundary.js');
const { closeOwnedListenerResources } = require('./hosted-listener-cleanup.js');
const leases = new WeakMap();
const fail = () => new Error('n08_hosted_listener_rejected');
async function createHostedListener(input) {
  return createListener(input, false);
}
async function createInstalledClientListener(input, attachUpgrades) {
  return createListener(input, true, attachUpgrades);
}
async function createListener(input, installed, attachUpgrades) {
  const options = exact(input, [
    'networkRoot',
    'ownedNode',
    'negativeAddress',
    'onBusinessRequest',
  ]);
  const policy = installed ? require('./installed-client-listener-policy') : null;
  if (policy) policy.installedListenerPaths(options);
  const localAddresses = Object.values(os.networkInterfaces()).flat().filter(Boolean);
  if (
    process.platform !== 'win32' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    fs.realpathSync.native(process.execPath).toLowerCase() !==
      fs.realpathSync.native(options.ownedNode).toLowerCase() ||
    !net.isIPv4(options.negativeAddress) ||
    !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(options.negativeAddress) ||
    !localAddresses.some(
      (item) => item.address === options.negativeAddress && item.internal === false
    ) ||
    typeof options.onBusinessRequest !== 'function' ||
    (attachUpgrades !== undefined &&
      (!installed ||
        typeof attachUpgrades !== 'function' ||
        types.isProxy(attachUpgrades) ||
        types.isAsyncFunction(attachUpgrades) ||
        types.isGeneratorFunction(attachUpgrades)))
  )
    throw fail();
  const pfx = fs.readFileSync(path.join(options.networkRoot, 'server.pfx'));
  const passphrase = fs.readFileSync(path.join(options.networkRoot, '.pfx-password'), 'utf8');
  if (pfx.length < 100 || pfx.length > 65536 || !/^[A-Za-z0-9+/]{43}=$/.test(passphrase))
    throw fail();
  const sockets = new Set();
  let negativeConnections = 0;
  const remember = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  const negative = net.createServer((socket) => {
    negativeConnections++;
    remember(socket);
    socket.destroy();
  });
  const server = https.createServer(
    { pfx, passphrase, minVersion: 'TLSv1.2' },
    (request, response) => {
      if (request.socket.remoteAddress !== '127.0.0.1') {
        response.destroy();
        return;
      }
      if (request.method === 'GET' && request.url === '/__n08_probe') {
        response.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
        response.end('N08_SYNTHETIC_TLS_OK');
        return;
      }
      if (
        request.method !== 'POST' ||
        (installed
          ? !policy.installedClientRequest(request.url, request.socket.servername)
          : !['/v1/responses', '/v1/responses/compact'].includes(request.url))
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      let bytes = 0;
      const chunks = [];
      request.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 262144) {
          request.destroy();
          response.destroy();
        } else chunks.push(Buffer.from(chunk));
      });
      request.on('error', () => response.destroy());
      request.on('end', () => {
        if (bytes > 262144 || request.aborted || response.destroyed) return;
        try {
          // This is the synthetic server's trusted fixture handler, not a product
          // hook. It owns fixed response buffers, stage counters and response holds.
          const event = {
            path: request.url,
            authorization: request.headers.authorization,
            bytes: Buffer.concat(chunks),
            response,
          };
          if (installed) event.apiKey = request.headers['x-api-key'];
          const result = options.onBusinessRequest(event);
          Promise.resolve(result).catch(() => response.destroy());
        } catch {
          response.destroy();
        }
      });
    }
  );
  server.on('connection', remember);
  negative.on('error', () => {});
  server.on('error', () => {});
  const listen = (listener, host, port) =>
    new Promise((resolve, reject) => {
      const error = () => {
        listener.removeListener('listening', ready);
        reject(fail());
      };
      const ready = () => {
        listener.removeListener('error', error);
        resolve();
      };
      listener.once('error', error);
      listener.once('listening', ready);
      listener.listen({ host, port, exclusive: true });
    });
  let upgrades;
  const closeResources = () => closeOwnedListenerResources(sockets, [server, negative], upgrades);
  try {
    if (attachUpgrades) {
      upgrades = exact(attachUpgrades(server), ['inspect', 'close']);
      if (typeof upgrades.inspect !== 'function' || typeof upgrades.close !== 'function')
        throw fail();
    }
    await listen(server, '127.0.0.1', 443);
    await listen(negative, options.negativeAddress, 0);
  } catch {
    await closeResources();
    throw fail();
  }
  let ended = false;
  const lease = Object.freeze({
    inspect() {
      if (ended || !server.listening || !negative.listening) throw fail();
      return Object.freeze({
        pid: process.pid,
        tlsAddress: '127.0.0.1',
        tlsPort: 443,
        negativeAddress: options.negativeAddress,
        negativePort: negative.address().port,
        negativeConnections,
      });
    },
    async close() {
      ended = true;
      leases.delete(lease);
      return closeResources();
    },
  });
  leases.set(lease, {
    node: fs.realpathSync.native(options.ownedNode),
    networkRoot: path.resolve(options.networkRoot),
  });
  return lease;
}
function checkHostedListener(lease, node, networkRoot) {
  const bound = leases.get(lease);
  if (
    !bound ||
    bound.node.toLowerCase() !== fs.realpathSync.native(node).toLowerCase() ||
    bound.networkRoot.toLowerCase() !== path.resolve(networkRoot).toLowerCase()
  )
    throw fail();
  return lease.inspect();
}
module.exports = { createHostedListener, createInstalledClientListener, checkHostedListener };
