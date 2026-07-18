const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { createLogger } = require('./logger');

const DEFAULT_PROXY_PORTS = Object.freeze([7890, 10809, 7893, 10808]);
const DETECTION_CACHE_MS = 15_000;
const DETECTION_TIMEOUT_MS = 250;
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const MAX_BUFFERED_BODY_BYTES = 10 * 1024 * 1024;

function normalizeTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.trunc(parsed), MAX_REQUEST_TIMEOUT_MS);
}

function parseHttpUrl(rawUrl, label) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch (error) {
    throw new TypeError(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${label} must use http: or https:`);
  }
  if (parsed.username || parsed.password) {
    throw new TypeError(`${label} must not include credentials`);
  }
  return parsed;
}

function getProxyAuthorization(proxy) {
  if (!proxy.username && !proxy.password) return null;
  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch (error) {
      return value;
    }
  };
  return (
    'Basic ' + Buffer.from(`${decode(proxy.username)}:${decode(proxy.password)}`).toString('base64')
  );
}

function shouldBypassProxy(target, environment = {}) {
  const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.')) return true;
  const rawNoProxy = environment.NO_PROXY || environment.no_proxy || '';
  const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80');
  return String(rawNoProxy)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') return true;
      const separator = entry.lastIndexOf(':');
      const hasPort = separator > -1 && entry.indexOf(':') === separator;
      const entryHost = (hasPort ? entry.slice(0, separator) : entry).replace(/^\./, '');
      const entryPort = hasPort ? entry.slice(separator + 1) : '';
      if (entryPort && entryPort !== targetPort) return false;
      return hostname === entryHost || hostname.endsWith(`.${entryHost}`);
    });
}

function createProxyTransport({
  loadConfig,
  shouldVerifyUpstreamTls = () => true,
  environment = process.env,
  proxyPorts = DEFAULT_PROXY_PORTS,
  logger = createLogger('proxy-transport'),
} = {}) {
  if (typeof loadConfig !== 'function') {
    throw new TypeError('createProxyTransport requires loadConfig');
  }

  let detectedProxyUrl = null;
  let detectedProxyType = 'http';
  let lastDetectTime = 0;
  let proxyDetectCached = false;

  function resetLocalProxyDetectionCache() {
    detectedProxyUrl = null;
    detectedProxyType = 'http';
    lastDetectTime = 0;
    proxyDetectCached = false;
  }

  function finishDetection(callback, proxyUrl, proxyType = 'http') {
    detectedProxyUrl = proxyUrl;
    detectedProxyType = proxyType;
    lastDetectTime = Date.now();
    proxyDetectCached = true;
    callback(proxyUrl, proxyType);
  }

  function detectLocalProxy(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('detectLocalProxy requires a callback');
    }
    try {
      const cfg = loadConfig();
      if (cfg?.appSettings?.disableLocalProxy) {
        callback(null, 'http');
        return;
      }
    } catch (error) {
      logger.warn({ err: error }, 'Could not read local proxy settings');
    }

    if (proxyDetectCached && Date.now() - lastDetectTime < DETECTION_CACHE_MS) {
      callback(detectedProxyUrl, detectedProxyType);
      return;
    }

    const envProxy =
      environment.HTTPS_PROXY ||
      environment.HTTP_PROXY ||
      environment.https_proxy ||
      environment.http_proxy;
    if (envProxy) {
      let parsed;
      try {
        parsed = new URL(envProxy);
      } catch (error) {
        logger.warn({ err: error }, 'Ignoring invalid proxy URL from environment');
        finishDetection(callback, null);
        return;
      }
      const proxyType = parsed.protocol.startsWith('socks') ? 'socks5' : 'http';
      if (proxyType === 'http' && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        logger.warn('Ignoring unsupported proxy URL protocol');
        finishDetection(callback, null);
        return;
      }
      finishDetection(callback, parsed.toString(), proxyType);
      return;
    }

    const ports = Array.from(proxyPorts)
      .map(Number)
      .filter((port) => Number.isSafeInteger(port) && port >= 1 && port <= 65535);
    if (ports.length === 0) {
      finishDetection(callback, null);
      return;
    }

    let finished = 0;
    let found = false;
    const markUnavailable = () => {
      finished += 1;
      if (finished === ports.length && !found) finishDetection(callback, null);
    };
    const markFound = (port, type) => {
      if (found) return;
      found = true;
      const proxyUrl = `${type}://127.0.0.1:${port}`;
      logger.info({ proxyType: type, port }, 'Auto-detected local proxy');
      finishDetection(callback, proxyUrl, type);
    };

    for (const port of ports) {
      const socket = new net.Socket();
      let connected = false;
      let settled = false;
      const settleUnavailable = () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        markUnavailable();
      };
      const settleFound = (type) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        markFound(port, type);
      };

      socket.setTimeout(DETECTION_TIMEOUT_MS);
      socket.once('connect', () => {
        connected = true;
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
      });
      socket.once('data', (chunk) => {
        settleFound(chunk.length >= 2 && chunk[0] === 0x05 ? 'socks5' : 'http');
      });
      socket.once('end', () => (connected ? settleFound('http') : settleUnavailable()));
      socket.once('close', () => {
        if (!settled) connected ? settleFound('http') : settleUnavailable();
      });
      socket.once('timeout', () => (connected ? settleFound('http') : settleUnavailable()));
      socket.once('error', settleUnavailable);
      socket.connect(port, '127.0.0.1');
    }
  }

  function requestWithProxy(targetUrl, options = {}, callback) {
    const emitter = new EventEmitter();
    const requestTimeout = normalizeTimeout(options.timeout);
    const bodyChunks = [];
    let bufferedBytes = 0;
    let payloadRequest = null;
    let ended = false;
    let destroyedError = null;
    let fallbackTriggered = false;

    function fail(error) {
      queueMicrotask(() => emitter.emit('error', error));
    }

    let target;

    function attachRequestTimeout(request) {
      if (requestTimeout > 0 && typeof request.setTimeout === 'function') {
        request.setTimeout(requestTimeout, () => {
          request.destroy(new Error(`Request timeout (${requestTimeout}ms)`));
        });
      }
      return request;
    }

    function activatePayloadRequest(request, onError) {
      payloadRequest = request;
      emitter.activeReq = request;
      request.on('error', onError || ((error) => emitter.emit('error', error)));
      request.once('finish', () => emitter.emit('finish'));
      for (const chunk of bodyChunks) request.write(chunk);
      if (destroyedError) request.destroy(destroyedError);
      else if (ended) request.end();
    }

    emitter.write = function write(chunk, encoding, callbackFn) {
      if (ended) throw new Error('write after end');
      const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding);
      bufferedBytes += normalized.length;
      if (bufferedBytes > MAX_BUFFERED_BODY_BYTES) {
        const error = new RangeError('Buffered proxy request body is too large');
        emitter.destroy(error);
        return false;
      }
      bodyChunks.push(normalized);
      const accepted = payloadRequest ? payloadRequest.write(normalized) : true;
      if (typeof callbackFn === 'function') queueMicrotask(callbackFn);
      return accepted;
    };
    emitter.end = function end(chunk, encoding, callbackFn) {
      if (chunk !== undefined && chunk !== null) emitter.write(chunk, encoding);
      ended = true;
      if (payloadRequest) payloadRequest.end(callbackFn);
      else if (typeof callbackFn === 'function') emitter.once('finish', callbackFn);
      return emitter;
    };
    emitter.destroy = function destroy(error = new Error('Request destroyed')) {
      destroyedError = error;
      if (emitter.activeReq?.destroy) emitter.activeReq.destroy(error);
      else fail(error);
      return emitter;
    };

    try {
      target = parseHttpUrl(targetUrl, 'targetUrl');
    } catch (error) {
      fail(error);
      return emitter;
    }

    function executeDirect() {
      if (fallbackTriggered) return;
      fallbackTriggered = true;
      const transport = target.protocol === 'https:' ? https : http;
      const request = attachRequestTimeout(transport.request(target, options, callback));
      activatePayloadRequest(request);
    }

    if (shouldBypassProxy(target, environment)) {
      executeDirect();
      return emitter;
    }

    detectLocalProxy((proxyUrl, proxyType) => {
      if (!proxyUrl) {
        executeDirect();
        return;
      }

      let proxy;
      try {
        proxy = new URL(proxyUrl);
      } catch (error) {
        logger.warn({ err: error }, 'Detected proxy URL is invalid; using direct connection');
        executeDirect();
        return;
      }

      if (target.protocol === 'https:' && proxyType === 'socks5') {
        let socksAgent;
        try {
          socksAgent = new SocksProxyAgent(proxyUrl, { timeout: requestTimeout || 5000 });
        } catch (error) {
          logger.warn(
            { err: error },
            'SOCKS5 agent initialization failed; using direct connection'
          );
          executeDirect();
          return;
        }
        const request = attachRequestTimeout(
          https.request(
            {
              agent: socksAgent,
              hostname: target.hostname,
              port: target.port || 443,
              path: `${target.pathname}${target.search}`,
              method: options.method || 'GET',
              headers: { ...(options.headers || {}), host: target.hostname },
            },
            callback
          )
        );
        activatePayloadRequest(request, (error) => {
          if (!fallbackTriggered) {
            logger.warn({ err: error }, 'SOCKS5 request failed; using direct connection');
            payloadRequest = null;
            executeDirect();
          } else emitter.emit('error', error);
        });
        return;
      }

      if (target.protocol === 'https:') {
        const proxyTransport = proxy.protocol === 'https:' ? https : http;
        const proxyAuthorization = getProxyAuthorization(proxy);
        const connectRequest = attachRequestTimeout(
          proxyTransport.request({
            hostname: proxy.hostname,
            port: proxy.port,
            method: 'CONNECT',
            path: `${target.hostname}:${target.port || 443}`,
            headers: proxyAuthorization ? { 'Proxy-Authorization': proxyAuthorization } : {},
            rejectUnauthorized: shouldVerifyUpstreamTls(),
          })
        );
        emitter.activeReq = connectRequest;
        connectRequest.once('connect', (response, socket) => {
          if (fallbackTriggered) {
            socket.destroy();
            return;
          }
          if (response.statusCode !== 200) {
            socket.destroy();
            emitter.emit('error', new Error(`Tunnel connection failed: ${response.statusCode}`));
            return;
          }
          fallbackTriggered = true;
          const tlsSocket = tls.connect({
            socket,
            servername: target.hostname,
            rejectUnauthorized: shouldVerifyUpstreamTls(),
          });
          tlsSocket.once('error', (error) => emitter.emit('error', error));
          tlsSocket.once('secureConnect', () => {
            const request = attachRequestTimeout(
              http.request(
                {
                  createConnection: () => tlsSocket,
                  method: options.method || 'GET',
                  path: `${target.pathname}${target.search}`,
                  headers: { ...(options.headers || {}), host: target.hostname },
                },
                callback
              )
            );
            activatePayloadRequest(request);
          });
        });
        connectRequest.once('error', (error) => {
          if (!fallbackTriggered) {
            logger.warn({ err: error }, 'HTTP proxy tunnel failed; using direct connection');
            executeDirect();
          } else emitter.emit('error', error);
        });
        connectRequest.end();
        return;
      }

      const headers = { ...(options.headers || {}), host: target.hostname };
      const proxyAuthorization = getProxyAuthorization(proxy);
      if (proxyAuthorization) headers['Proxy-Authorization'] = proxyAuthorization;
      const proxyTransport = proxy.protocol === 'https:' ? https : http;
      const request = attachRequestTimeout(
        proxyTransport.request(
          {
            hostname: proxy.hostname,
            port: proxy.port,
            path: target.toString(),
            method: options.method || 'GET',
            headers,
            rejectUnauthorized: shouldVerifyUpstreamTls(),
          },
          callback
        )
      );
      activatePayloadRequest(request);
    });

    return emitter;
  }

  return { detectLocalProxy, requestWithProxy, resetLocalProxyDetectionCache };
}

module.exports = {
  createProxyTransport,
  normalizeTimeout,
  shouldBypassProxy,
  MAX_BUFFERED_BODY_BYTES,
};
