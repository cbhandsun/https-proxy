'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  observeUpstreamRequestConnection,
} = require('../lib/proxy/handlers/upstream-connection-observer');
const {
  collectUpstreamRequestFailureDiagnostics,
} = require('../lib/proxy/handlers/upstream-stream-guard');

function createRequest() {
  const request = new EventEmitter();
  request.reusedSocket = false;
  return request;
}

function diagnose(request, observer, error) {
  return collectUpstreamRequestFailureDiagnostics({
    proxyReq: request,
    connectionSnapshot: observer.snapshot(),
    error,
  });
}

// A fresh TLS connection retains its validated peer and milestones after the
// socket is destroyed and its remote address disappears.
{
  const request = createRequest();
  const socket = new EventEmitter();
  Object.assign(socket, { connecting: true, encrypted: true, secureConnecting: true });
  const observer = observeUpstreamRequestConnection(request);
  request.socket = socket;
  request.emit('socket', socket);
  assert.equal(diagnose(request, observer).upstreamFailurePhase, 'tcp_connect');

  socket.emit('lookup', null, '104.18.32.47');
  socket.connecting = false;
  socket.remoteAddress = '104.18.32.47';
  socket.remotePort = 443;
  socket.localPort = 53000;
  socket.emit('connect');
  request.socket = null;
  socket.remoteAddress = undefined;
  socket.remotePort = undefined;
  socket.localPort = undefined;

  const handshake = diagnose(request, observer, {
    code: 'ECONNRESET',
    message: 'Authorization: Bearer secret-token',
  });
  assert.equal(handshake.upstreamFailurePhase, 'tls_handshake');
  assert.equal(handshake.upstreamErrorCode, 'ECONNRESET');
  assert.doesNotMatch(JSON.stringify(handshake), /secret-token|Authorization/i);
  assert.equal(handshake.upstreamDnsAddress, '104.18.32.47');
  assert.equal(handshake.upstreamRemoteAddress, '104.18.32.47');
  assert.equal(handshake.upstreamRemotePort, 443);
  assert.equal(handshake.upstreamLocalPort, 53000);
  assert.equal(handshake.upstreamTcpConnectObserved, true);
  assert.equal(handshake.upstreamTlsSecureConnectObserved, false);
  assert.equal(handshake.upstreamRequestFinished, false);

  const matchingBody = collectUpstreamRequestFailureDiagnostics({
    proxyReq: request,
    connectionSnapshot: observer.snapshot(),
    requestBodyByteLength: 1024,
    contentLength: '1024',
  });
  assert.equal(matchingBody.upstreamRequestBodyBytes, 1024);
  assert.equal(matchingBody.upstreamContentLengthMatches, true);
  assert.equal(
    collectUpstreamRequestFailureDiagnostics({
      requestBodyByteLength: 1024,
      contentLength: '1025',
    }).upstreamContentLengthMatches,
    false
  );

  socket.emit('secureConnect');
  request.emit('finish');
  const waiting = diagnose(request, observer);
  assert.equal(waiting.upstreamFailurePhase, 'awaiting_response');
  assert.equal(waiting.upstreamTlsSecureConnectObserved, true);
  assert.equal(waiting.upstreamRequestFinished, true);
}

// A reused socket has no new DNS, TCP, or TLS events. It is already connected.
{
  const request = createRequest();
  request.reusedSocket = true;
  const socket = new EventEmitter();
  Object.assign(socket, {
    connecting: false,
    encrypted: true,
    secureConnecting: false,
    remoteAddress: '172.64.155.209',
    remotePort: 443,
    localPort: 53001,
  });
  const observer = observeUpstreamRequestConnection(request);
  request.socket = socket;
  request.emit('socket', socket);
  request.socket = null;
  const detail = diagnose(request, observer, {
    code: 'ECONNRESET\r\nAuthorization: Bearer secret-token',
    message: 'Bearer secret-token',
  });
  assert.equal(detail.upstreamFailurePhase, 'awaiting_response');
  assert.equal(detail.upstreamRequestReusedSocket, true);
  assert.equal(detail.upstreamRemoteAddress, '172.64.155.209');
  assert.equal(detail.upstreamLocalPort, 53001);
  assert.equal(detail.upstreamTcpConnectObserved, false);
  assert.equal(detail.upstreamTlsSecureConnectObserved, false);
  assert.equal(detail.upstreamErrorCode, undefined);
}

// Invalid peer metadata and arbitrary error text never enter diagnostics.
{
  const request = createRequest();
  const socket = new EventEmitter();
  Object.assign(socket, {
    connecting: true,
    encrypted: true,
    secureConnecting: true,
    remoteAddress: 'Bearer secret-token',
    remotePort: 70000,
    localPort: 70000,
    headers: { authorization: 'Bearer secret-token' },
  });
  const observer = observeUpstreamRequestConnection(request);
  request.socket = socket;
  request.emit('socket', socket);
  socket.emit('lookup', null, 'Bearer secret-token');
  socket.emit('connect');
  socket.emit('close');
  assert.equal(socket.listenerCount('lookup'), 0);
  assert.equal(socket.listenerCount('connect'), 0);
  assert.equal(socket.listenerCount('secureConnect'), 0);
  request.socket = null;
  const detail = diagnose(request, observer);
  assert.equal(detail.upstreamDnsAddress, undefined);
  assert.equal(detail.upstreamRemoteAddress, undefined);
  assert.equal(detail.upstreamRemotePort, undefined);
  assert.equal(detail.upstreamLocalPort, undefined);
  assert.equal(detail.upstreamErrorCode, undefined);
  assert.doesNotMatch(JSON.stringify(detail), /secret-token|Bearer|authorization/i);
  assert.equal(
    collectUpstreamRequestFailureDiagnostics({
      proxyReq: { socket: { localPort: 0 } },
    }).upstreamLocalPort,
    undefined
  );
  assert.equal(
    collectUpstreamRequestFailureDiagnostics({
      proxyReq: { socket: { localPort: '53002' } },
    }).upstreamLocalPort,
    undefined
  );
  assert.equal(
    collectUpstreamRequestFailureDiagnostics({
      proxyReq: { socket: { localPort: 65535 } },
    }).upstreamLocalPort,
    65535
  );
  const invalidLengths = collectUpstreamRequestFailureDiagnostics({
    requestBodyByteLength: Number.MAX_SAFE_INTEGER + 1,
    contentLength: '999999999999999999999999999999',
  });
  assert.equal(invalidLengths.upstreamRequestBodyBytes, undefined);
  assert.equal(invalidLengths.upstreamContentLengthMatches, undefined);
}

// No request/socket is a valid empty boundary.
{
  const observer = observeUpstreamRequestConnection(null);
  assert.equal(observer.snapshot().socketAssigned, false);
  assert.equal(
    collectUpstreamRequestFailureDiagnostics({}).upstreamFailurePhase,
    'socket_unassigned'
  );
}
