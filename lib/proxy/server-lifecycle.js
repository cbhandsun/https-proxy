const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const {
  createConcurrencyGuard,
  createUpgradeGuard,
  hardenHttpServer,
} = require('./inbound-controls');
const { writeTextFileAtomically } = require('./management-utils');
const { createProxyPidPersistence, writeProxyPidFileAsync } = require('./proxy-pid-persistence');
const { createProxyShutdown } = require('./server-shutdown');
const { createStartupCredentials } = require('./startup-credentials');
const { createStoppingAdmission } = require('./stopping-admission');

function scheduleReadyCallback(onReady, schedule = setImmediate) {
  if (typeof onReady !== 'function') return;
  schedule(function () {
    try {
      onReady();
    } catch (_error) {}
  });
}

function notifyStartupPhase(onPhase, phase) {
  if (typeof onPhase !== 'function') return;
  try {
    onPhase(phase);
  } catch (_error) {}
}

function proxyPidFile(dataDir) {
  return path.join(dataDir, '.proxy.pid');
}

function writeProxyPidFile(dataDir, pid = process.pid) {
  try {
    writeTextFileAtomically(proxyPidFile(dataDir), String(pid) + '\n');
    return true;
  } catch (_error) {
    return false;
  }
}

function clearProxyPidFile(dataDir, pid = process.pid) {
  try {
    const filePath = proxyPidFile(dataDir);
    const current = fs.readFileSync(filePath, 'utf8').trim();
    if (current === String(pid)) fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    // An aborted initial write may never have published a PID. Absence is
    // already clean; other filesystem errors must still fail shutdown.
    return error?.code === 'ENOENT';
  }
}

function startProxyServers(dependencies = {}) {
  const {
    ACTIVE_HTTPS_SERVERS,
    APP_ID,
    DATA_DIR,
    ensureCert,
    exceptionHandlers,
    handleRequest,
    handleUpgrade,
    installManagementCorsGuard,
    log,
    parsePortOrDefault,
    writeManagementTokenFile,
    getRuntimeState,
    onPhase,
    onReady,
    contextRecoveryLifecycle,
    proxyStopControl,
  } = dependencies;
  if (typeof getRuntimeState !== 'function') {
    throw new TypeError('startProxyServers requires getRuntimeState');
  }
  const runtimeState = getRuntimeState();
  const { ACTIVE_PROFILE, CONFIG, ENTRY_SERVERS, LOCAL_SERVER, MODEL_ROUTES, PORT } = runtimeState;

  const MGMT_PORT = parsePortOrDefault(
    process.env.MGMT_PORT || CONFIG.localServer?.managementPort,
    PORT <= 65435 ? PORT + 100 : 3543
  );
  notifyStartupPhase(onPhase, 'server_start_requested');

  const checkExistingManagementServer = function (callback) {
    let settled = false;
    function finish(isProxy) {
      if (settled) return;
      settled = true;
      callback(isProxy);
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port: MGMT_PORT,
        path: '/v1/local/health',
        method: 'GET',
        timeout: 500,
      },
      function (res) {
        const chunks = [];
        let bytes = 0;
        res.on('data', function (chunk) {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
          bytes += buffer.length;
          if (bytes > 4096) {
            chunks.length = 0;
            req.destroy();
            finish(false);
            return;
          }
          chunks.push(buffer);
        });
        res.on('end', function () {
          if (settled) return;
          try {
            const body = Buffer.concat(chunks, bytes).toString('utf8');
            const parsed = JSON.parse(body || '{}');
            finish(res.statusCode >= 200 && res.statusCode < 300 && parsed.appId === APP_ID);
          } catch (err) {
            finish(false);
          }
        });
      }
    );
    req.on('timeout', function () {
      req.destroy();
      finish(false);
    });
    req.on('error', function () {
      finish(false);
    });
    req.end();
  };

  const startServers = function () {
    const envEntry = process.env.PORT ? [{ ...LOCAL_SERVER, listenPort: PORT }] : ENTRY_SERVERS;
    // HTTP-only entries do not need TLS keys or certificate generation.
    const tlsConfig = envEntry.some((entry) => entry.tls !== false) ? ensureCert() : undefined;
    notifyStartupPhase(onPhase, 'certificate_ready');
    const servers = [];
    const entryConcurrencyState = { activeRequests: 0 };
    const serverHardeningOptions = {
      requestTimeoutMs: process.env.PROXY_REQUEST_TIMEOUT_MS,
      headersTimeoutMs: process.env.PROXY_HEADERS_TIMEOUT_MS,
      keepAliveTimeoutMs: process.env.PROXY_KEEP_ALIVE_TIMEOUT_MS,
      maxRequestsPerSocket: process.env.PROXY_MAX_REQUESTS_PER_SOCKET,
      maxHeadersCount: process.env.PROXY_MAX_HEADERS_COUNT,
      maxConnections: process.env.PROXY_MAX_CONNECTIONS,
    };

    // Wire safety-module shutdown hook to our local shutdown
    try {
      exceptionHandlers.setShutdownHook(function (_reason) {
        shutdown();
      });
    } catch (e) {}

    let isShuttingDown = false;
    const admission = createStoppingAdmission({
      isStopping: () => isShuttingDown,
      handleRequest,
      handleUpgrade,
      closeIdleConnections: () => {
        for (const server of servers) server.closeIdleConnections();
      },
    });
    const credentialStartup = createStartupCredentials({
      write: () => writeManagementTokenFile(MGMT_PORT),
      onReady() {
        notifyStartupPhase(onPhase, 'management_token_ready');
        for (const entry of envEntry) listenEntry(entry);
        notifyStartupPhase(onPhase, 'management_listening');
        markPortListening();
      },
      onFailure() {
        log.error('[startup] Unable to persist management credentials; refusing to start.');
        shutdown(1);
      },
    });
    const pidPersistence = createProxyPidPersistence({
      write: (signal) => writeProxyPidFileAsync(DATA_DIR, process.pid, { signal }),
      clear: () => clearProxyPidFile(DATA_DIR),
      warn: () =>
        log.warn('[startup] Unable to persist proxy pid file; runtime health remains available.'),
    });
    const stop = createProxyShutdown({
      servers,
      beforeListenersClose: () => credentialStartup.stop(),
      shutdownUpgrades: () => admission.closeUpgrades(),
      shutdownRecovery: contextRecoveryLifecycle
        ? () => contextRecoveryLifecycle.shutdownAsync()
        : undefined,
      stopPid: () => pidPersistence.stop(),
      reportFailure: () => log.error('[shutdown] Unable to finalize proxy resources.'),
    });
    let exitStatus = 0;
    function shutdown(failureCode) {
      if (failureCode === 1) exitStatus = 1;
      if (isShuttingDown) return;
      isShuttingDown = true;
      void stop().then((success) => process.exit(success ? exitStatus : 1));
    }

    if (proxyStopControl) proxyStopControl.bind(shutdown, MGMT_PORT);

    function handleListenError(serverName, err) {
      if (err && err.code === 'EADDRINUSE') {
        log.error(
          '[startup] ' +
            serverName +
            ' is already in use. Stop the owning process or change the configured port.'
        );
        shutdown(1);
        return;
      }
      log.error('[startup] ' + serverName + ' failed: ' + (err && err.message ? err.message : err));
      shutdown(1);
    }

    let pendingListeners = envEntry.length + 1;
    function markPortListening() {
      pendingListeners -= 1;
      if (pendingListeners === 0 && !isShuttingDown) {
        void pidPersistence.start();
        notifyStartupPhase(onPhase, 'ports_listening');
        log.info('  Mgmt:    http://127.0.0.1:' + MGMT_PORT + '/v1/local/*  [management-http]');
        scheduleReadyCallback(onReady);
      }
    }

    function listenEntry(entry) {
      const factory = entry.tls === false ? http : https;
      const requestHandler = createConcurrencyGuard(
        function (req, res) {
          admission.request(req, res, entry);
        },
        {
          maxConcurrentRequests: process.env.PROXY_MAX_INBOUND_REQUESTS,
          state: entryConcurrencyState,
        }
      );
      const server =
        entry.tls === false
          ? factory.createServer(requestHandler)
          : factory.createServer(tlsConfig, requestHandler);
      hardenHttpServer(server, serverHardeningOptions);
      if (typeof handleUpgrade === 'function') {
        server.on(
          'upgrade',
          createUpgradeGuard(function (req, socket, head) {
            return admission.upgrade(req, socket, head, entry);
          })
        );
      }
      servers.push(server);
      if (entry.tls !== false) ACTIVE_HTTPS_SERVERS.push(server);
      const listenHost = entry.host === 'localhost' ? '127.0.0.1' : entry.host;
      server.on('error', function (err) {
        handleListenError('port ' + listenHost + ':' + entry.listenPort, err);
      });
      server.listen(entry.listenPort, listenHost, function () {
        log.info(
          '  Listen:  ' +
            (entry.tls === false ? 'http' : 'https') +
            '://' +
            entry.host +
            ':' +
            entry.listenPort +
            entry.basePath +
            '  [' +
            entry.protocol +
            ']'
        );
        markPortListening();
      });
      return server;
    }

    log.info('');
    log.info('+-----------------------------------------------+');
    log.info('|        OpenAI HTTPS Proxy                      |');
    log.info('+-----------------------------------------------+');
    log.info('');

    // ── HTTP 管理端口 ──────────────────────────────────
    // 纯 HTTP 服务器，仅处理 /v1/local/* 管理 API，不转发代理请求。
    // 解决 Tauri 生产模式下 webview 无法访问自签名 HTTPS 的问题。
    const managementHandler = createConcurrencyGuard(
      function (req, res) {
        if (!credentialStartup.ready() || isShuttingDown) {
          res.writeHead(503, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            Connection: 'close',
          });
          res.end(JSON.stringify({ error: 'Management initialization unavailable' }));
          return;
        }
        const urlPath = req.url || '';
        if (!installManagementCorsGuard(req, res)) return;
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
        // 只允许 /v1/local/* 管理端点
        if (urlPath.startsWith('/v1/local/') || urlPath.startsWith('/local/')) {
          handleRequest(req, res, envEntry[0] || LOCAL_SERVER);
          return;
        }
        // 拒绝其他所有请求（不允许通过 HTTP 管理端口做代理转发）
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Management port only accepts /v1/local/* requests' }));
      },
      {
        maxConcurrentRequests: process.env.PROXY_MAX_MANAGEMENT_REQUESTS || 32,
        trackActivity: false,
      }
    );
    const mgmtServer = http.createServer(managementHandler);
    hardenHttpServer(mgmtServer, {
      ...serverHardeningOptions,
      maxConnections: process.env.PROXY_MAX_MANAGEMENT_CONNECTIONS || 64,
    });
    servers.push(mgmtServer);
    notifyStartupPhase(onPhase, 'servers_created');
    mgmtServer.on('error', function (err) {
      handleListenError('management port 127.0.0.1:' + MGMT_PORT, err);
    });
    // The health probe is advisory: concurrent startups can both pass it.
    // Claim the management port before publishing credentials, otherwise a
    // losing process can overwrite the surviving process's token file.
    mgmtServer.listen(MGMT_PORT, '127.0.0.1', function () {
      void credentialStartup.start();
    });

    process.nextTick(function () {
      log.info('');
      log.info('  Profile: ' + (ACTIVE_PROFILE.name || ACTIVE_PROFILE.id || 'default'));
      log.info('  Target:  ' + ACTIVE_PROFILE.targetUrl);
      log.info('  Routes:  ' + MODEL_ROUTES.length);
      log.info('');
      log.info('  SDK Config:');
      for (const entry of envEntry) {
        log.info(
          '    ' +
            entry.protocol +
            ': ' +
            (entry.tls === false ? 'http' : 'https') +
            '://' +
            entry.host +
            ':' +
            entry.listenPort +
            entry.basePath
        );
      }
      log.info('    management: http://127.0.0.1:' + MGMT_PORT + '/v1/local/*');
      log.info('    mgmt_token_file: ' + path.join(DATA_DIR, `.mgmt-token-${MGMT_PORT}`));
      log.info('');
      log.info('  Ctrl+C to stop');
      log.info('');
    });

    process.on('SIGINT', function () {
      log.info('\nStopping...');
      shutdown();
    });
    process.on('SIGTERM', shutdown);
  };

  checkExistingManagementServer(function (isRunning) {
    notifyStartupPhase(onPhase, 'existing_instance_checked');
    if (isRunning) {
      log.info(
        '[single-instance] Existing proxy management endpoint detected on 127.0.0.1:' +
          MGMT_PORT +
          '; exiting duplicate process.'
      );
      process.exit(0);
      return;
    }
    startServers();
  });
}

module.exports = {
  clearProxyPidFile,
  notifyStartupPhase,
  scheduleReadyCallback,
  startProxyServers,
  writeProxyPidFile,
};
