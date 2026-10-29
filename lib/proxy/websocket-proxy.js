'use strict';

const http = require('http');
const https = require('https');
const { parseTargetUrl } = require('./routing');
const { authorizeEntryRequest, profileMatchesEntryKey } = require('./entry-auth');
const { createLogger } = require('./logger');
const { createContextForwardHeaders } = require('./context-transport-policy');
const { createWebSocketLifecycle } = require('./websocket-lifecycle');
const {
  nativeRecoveryProviderAllowed,
  createRecoveryHttpAuthorization,
} = require('./context-recovery-http-entry');

const log = createLogger('websocket');

function createWebSocketProxy(dependencies = {}) {
  const {
    getConfig,
    getProfiles,
    getActiveProfile,
    resolveRoute,
    resolveOfficialCredentials,
    globalHttpAgent,
    globalHttpsAgent,
    contextRecoveryLifecycle,
    recoveryProviderAllowed = nativeRecoveryProviderAllowed,
  } = dependencies;

  return async function handleUpgrade(clientReq, clientSocket, clientHead, entry) {
    const config = typeof getConfig === 'function' ? getConfig() : {};
    const urlString = clientReq.url || '/';
    const clientUrl = new URL(urlString, `http://${clientReq.headers.host || 'localhost'}`);
    const clientPath = clientUrl.pathname;

    // 1. Entry Auth Check
    const authResult = authorizeEntryRequest(clientReq, entry, config);
    if (!authResult.ok) {
      log.warn('[websocket] entry_authentication_failed');
      try {
        clientSocket.write(
          'HTTP/1.1 401 Unauthorized\r\n' +
            'Content-Type: application/json; charset=utf-8\r\n' +
            'Connection: close\r\n\r\n' +
            JSON.stringify({
              error: {
                type: 'authentication_error',
                message: 'Invalid or missing proxy entry API key.',
              },
            })
        );
        clientSocket.destroy();
      } catch (_) {}
      return;
    }

    // 2. Check if endpoint supports WebSocket upgrade
    const isResponsesPath =
      clientPath === '/v1/responses' ||
      clientPath === '/responses' ||
      clientPath.endsWith('/responses');
    const isRealtimePath =
      clientPath === '/v1/realtime' ||
      clientPath === '/realtime' ||
      clientPath.endsWith('/realtime');

    if (!isResponsesPath && !isRealtimePath) {
      log.warn('[websocket] unsupported_upgrade_path');
      try {
        clientSocket.write(
          'HTTP/1.1 404 Not Found\r\n' +
            'Content-Type: text/plain\r\n' +
            'Connection: close\r\n\r\n' +
            'Not Found\r\n'
        );
        clientSocket.destroy();
      } catch (_) {}
      return;
    }

    // 3. Resolve Route & Target
    let modelHint = '';
    const routingHint = clientReq.headers['x-codex-routing-hint'];
    if (typeof routingHint === 'string') {
      const match = routingHint.match(/(?:^|[;,])\s*model=([^;,]+)/i);
      if (match) modelHint = match[1].trim();
    }
    if (!modelHint && clientUrl.searchParams.has('model')) {
      modelHint = clientUrl.searchParams.get('model').trim();
    }
    if (!modelHint && clientReq.headers['x-codex-turn-metadata']) {
      try {
        const meta = JSON.parse(clientReq.headers['x-codex-turn-metadata']);
        if (meta && typeof meta.model === 'string') modelHint = meta.model.trim();
      } catch (_) {}
    }

    const defaultModel = isResponsesPath ? 'gpt-6.1-sol' : '-';
    const targetModel = modelHint || defaultModel;
    const resolved = typeof resolveRoute === 'function' ? resolveRoute(targetModel) : null;
    const profiles = typeof getProfiles === 'function' ? getProfiles(config) : [];
    const activeProfile = typeof getActiveProfile === 'function' ? getActiveProfile(config) : null;

    let profile = null;
    if (resolved) {
      if (resolved.profile) {
        profile = resolved.profile;
      } else if (resolved.profileId) {
        profile = profiles.find((p) => p.id === resolved.profileId) || null;
      } else if (resolved.route && resolved.route.profileId) {
        profile = profiles.find((p) => p.id === resolved.route.profileId) || null;
      }
    }
    if (!profile) {
      profile = activeProfile;
    }
    if (authResult.enabled && !profileMatchesEntryKey(authResult, profile)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    const sourceProfile = profile;
    let prepared = { profile: profile && { ...profile }, authMode: profile?.authMode };
    const lifecycle = createWebSocketLifecycle(clientSocket, clientHead);
    if (!lifecycle.available()) return;
    if (profile && typeof resolveOfficialCredentials === 'function') {
      try {
        const resolvedCredentials = await resolveOfficialCredentials(
          { profile: { ...profile }, authMode: profile.authMode },
          clientReq.headers
        );
        if (resolvedCredentials && resolvedCredentials.profile) {
          prepared = resolvedCredentials;
          profile = prepared.profile;
        }
      } catch (_) {
        log.warn('[websocket] credential_resolution_failed');
      }
    }
    if (!lifecycle.available()) return;

    if (!profile || !profile.targetUrl) {
      log.error('[websocket] target_profile_unavailable');
      try {
        clientSocket.write(
          'HTTP/1.1 502 Bad Gateway\r\n' +
            'Content-Type: application/json\r\n' +
            'Connection: close\r\n\r\n' +
            JSON.stringify({ error: { message: 'No target profile configured' } })
        );
        clientSocket.destroy();
      } catch (_) {}
      return;
    }

    const target = parseTargetUrl(profile.targetUrl);
    let relativePath = clientPath;
    if (relativePath.startsWith('/v1')) {
      relativePath = relativePath.replace(/^\/v1/, '');
    } else if (target.path && relativePath.startsWith(target.path)) {
      relativePath = relativePath.slice(target.path.length);
    }
    const basePath = target.path ? target.path.replace(/\/$/, '') : '';
    const upstreamPath = basePath + relativePath + clientUrl.search;

    log.info('[websocket] upgrade_started');

    // 4. Build outgoing headers
    const outgoingHeaders = createContextForwardHeaders(clientReq.headers, authResult.enabled);
    delete outgoingHeaders['host'];
    outgoingHeaders['host'] = target.hostname;

    if (target.hostname === 'chatgpt.com') {
      outgoingHeaders['origin'] = 'https://chatgpt.com';
    }

    const apiKey =
      profile.authMode === 'official-login'
        ? profile.apiKey || null
        : process.env.API_KEY || profile.apiKey || null;

    if (apiKey) {
      outgoingHeaders['authorization'] = 'Bearer ' + apiKey;
    }

    // 5. Connect to upstream
    const transport = target.protocol === 'https:' ? https : http;
    const agent = target.protocol === 'https:' ? globalHttpsAgent : globalHttpAgent;

    if (
      isResponsesPath &&
      contextRecoveryLifecycle &&
      config.appSettings?.contextRecoveryEnabled === true &&
      authResult.enabled === true &&
      recoveryProviderAllowed({
        kind: 'responses',
        target,
        path: upstreamPath.split('?')[0],
        prepared,
        requestOptions: { hostname: target.hostname, port: target.port || 443 },
      })
    ) {
      const runtime = contextRecoveryLifecycle.sessions;
      const authorized = createRecoveryHttpAuthorization(
        () => {
          const current = typeof getConfig === 'function' ? getConfig() : {};
          const route = typeof resolveRoute === 'function' ? resolveRoute(targetModel) : null;
          const profiles = typeof getProfiles === 'function' ? getProfiles(current) : [];
          const currentProfile =
            route?.profile ??
            profiles.find(
              (value) =>
                value.id === (route?.profileId ?? route?.route?.profileId ?? sourceProfile.id)
            ) ??
            (typeof getActiveProfile === 'function' ? getActiveProfile(current) : null);
          return {
            enabled:
              current.appSettings?.contextRecoveryEnabled === true &&
              contextRecoveryLifecycle.sessions === runtime,
            allowed: profileMatchesEntryKey(
              authorizeEntryRequest(clientReq, entry, current),
              currentProfile
            ),
            auth: authorizeEntryRequest(clientReq, entry, current),
            profile: currentProfile,
            environment: { apiKey: process.env.API_KEY ?? null, route: route?.route ?? null },
          };
        },
        authResult,
        prepared
      );
      if (authorized()) {
        const endpoint = new URL(profile.targetUrl);
        endpoint.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
        endpoint.pathname = upstreamPath.split('?')[0];
        endpoint.search = clientUrl.search;
        try {
          // HTTP startup and ordinary Upgrade forwarding do not need the
          // recovery framing stack. Resolve it only after current admission.
          const {
            startRecoveryWebSocketTransport,
          } = require('./context-recovery-websocket-transport');
          startRecoveryWebSocketTransport({
            clientReq,
            clientSocket,
            lifecycle,
            url: endpoint.toString(),
            headers: outgoingHeaders,
            agent,
            runtime,
            auth: authResult,
            prepared,
            authorized,
          });
        } catch {
          // Admission must never fall through to ordinary forwarding after a
          // recovery dispatch failure, or expose native/module error details.
          log.warn('[websocket] recovery_transport_initialization_failed');
          lifecycle.close();
        }
        return;
      }
    }

    const upstreamReq = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: upstreamPath,
      method: 'GET',
      headers: outgoingHeaders,
      agent,
    });

    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      if (!lifecycle.attachSocket(upstreamSocket)) return;

      let statusLine = `HTTP/1.1 ${upstreamRes.statusCode || 101} Switching Protocols\r\n`;
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        statusLine += `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`;
      }
      statusLine += '\r\n';
      clientSocket.write(statusLine);

      if (upstreamHead && upstreamHead.length) clientSocket.write(upstreamHead);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });

    upstreamReq.on('response', (upstreamRes) => {
      if (!lifecycle.available()) {
        upstreamRes.destroy();
        return;
      }
      let statusLine = `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage || 'Error'}\r\n`;
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        statusLine += `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`;
      }
      statusLine += '\r\n';
      clientSocket.write(statusLine);
      upstreamRes.pipe(clientSocket);
    });

    upstreamReq.on('error', () => {
      if (!lifecycle.available()) return;
      log.error('[websocket] upstream_upgrade_failed');
      if (!lifecycle.upgraded()) {
        try {
          clientSocket.write(
            'HTTP/1.1 502 Bad Gateway\r\n' +
              'Content-Type: text/plain\r\n' +
              'Connection: close\r\n\r\n' +
              'Bad Gateway\r\n'
          );
        } catch (_) {}
      }
      lifecycle.close();
    });

    if (!lifecycle.attachRequest(upstreamReq)) return;
    upstreamReq.end();
  };
}

module.exports = {
  createWebSocketProxy,
};
