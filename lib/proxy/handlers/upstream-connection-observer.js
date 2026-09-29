'use strict';

const net = require('node:net');
const { collectUpstreamRequestFailureDiagnostics } = require('./upstream-stream-guard');

function safeIp(value) {
  return typeof value === 'string' && net.isIP(value) ? value : null;
}

function safePort(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

/**
 * Keep only connection milestones. A destroyed TLS socket often loses remoteAddress
 * before ClientRequest emits its error, so failure diagnostics need an earlier snapshot.
 */
function observeUpstreamRequestConnection(proxyReq) {
  const state = {
    socketAssigned: false,
    tcpConnectPending: false,
    tlsHandshakePending: false,
    dnsLookupSeen: false,
    tcpConnectSeen: false,
    tlsSecureConnectSeen: false,
    requestFinished: false,
    dnsAddress: null,
    localPort: null,
    remoteAddress: null,
    remotePort: null,
  };
  const snapshot = () => ({ ...state });
  if (!proxyReq || typeof proxyReq.once !== 'function') return { snapshot };

  proxyReq.once('finish', () => {
    state.requestFinished = true;
  });
  proxyReq.once('socket', (socket) => {
    state.socketAssigned = true;
    if (!socket || typeof socket.once !== 'function') return;

    const capturePeer = () => {
      state.localPort = safePort(socket.localPort) || state.localPort;
      state.remoteAddress = safeIp(socket.remoteAddress) || state.remoteAddress;
      state.remotePort = safePort(socket.remotePort) || state.remotePort;
    };
    capturePeer();

    const pendingTcp = socket.connecting === true;
    const pendingTls = socket.encrypted === true && socket.secureConnecting === true;
    state.tcpConnectPending = pendingTcp;
    state.tlsHandshakePending = pendingTls;
    const onLookup = (error, address) => {
      state.dnsLookupSeen = true;
      if (!error) state.dnsAddress = safeIp(address);
    };
    const onConnect = () => {
      state.tcpConnectSeen = true;
      capturePeer();
    };
    const onSecureConnect = () => {
      state.tlsSecureConnectSeen = true;
      capturePeer();
    };
    const onClose = () => {
      socket.removeListener('lookup', onLookup);
      socket.removeListener('connect', onConnect);
      socket.removeListener('secureConnect', onSecureConnect);
    };

    if (pendingTcp) {
      socket.once('lookup', onLookup);
      socket.once('connect', onConnect);
    }
    if (pendingTls) socket.once('secureConnect', onSecureConnect);
    if (pendingTcp || pendingTls) socket.once('close', onClose);
  });
  return { snapshot };
}

function observeUpstreamRequestFailure(proxyReq, getContext) {
  const connection = observeUpstreamRequestConnection(proxyReq);
  return (error) =>
    collectUpstreamRequestFailureDiagnostics({
      ...(typeof getContext === 'function' ? getContext() : {}),
      proxyReq,
      connectionSnapshot: connection.snapshot(),
      error,
    });
}

module.exports = { observeUpstreamRequestConnection, observeUpstreamRequestFailure };
