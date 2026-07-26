const http = require('http');
const https = require('https');
const path = require('path');

function startProxyServers(dependencies = {}) {
  const {
    ACTIVE_HTTPS_SERVERS,
    APP_ID,
    DATA_DIR,
    ensureCert,
    exceptionHandlers,
    handleRequest,
    installManagementCorsGuard,
    log,
    parsePortOrDefault,
    writeManagementTokenFile,
    getRuntimeState,
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
    const tlsConfig = ensureCert();
    const servers = [];

    // Wire safety-module shutdown hook to our local shutdown
    try {
      exceptionHandlers.setShutdownHook(function (_reason) {
        shutdown();
      });
    } catch (e) {}

    function shutdown() {
      let remaining = servers.length;
      if (!remaining) process.exit(0);
      for (const server of servers) {
        try {
          server.close(function () {
            remaining -= 1;
            if (remaining === 0) process.exit(0);
          });
        } catch (err) {
          remaining -= 1;
          if (remaining === 0) process.exit(0);
        }
      }
    }

    function handleListenError(serverName, err) {
      if (err && err.code === 'EADDRINUSE') {
        log.error(
          '[startup] ' +
            serverName +
            ' is already in use. Stop the owning process or change the configured port.'
        );
        process.exit(1);
        return;
      }
      log.error('[startup] ' + serverName + ' failed: ' + (err && err.message ? err.message : err));
      process.exit(1);
    }

    function listenEntry(entry) {
      const factory = entry.tls === false ? http : https;
      const server =
        entry.tls === false
          ? factory.createServer(function (req, res) {
              handleRequest(req, res, entry);
            })
          : factory.createServer(tlsConfig, function (req, res) {
              handleRequest(req, res, entry);
            });
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
      });
      return server;
    }

    log.info('');
    log.info('+-----------------------------------------------+');
    log.info('|        OpenAI HTTPS Proxy                      |');
    log.info('+-----------------------------------------------+');
    log.info('');

    const envEntry = process.env.PORT ? [{ ...LOCAL_SERVER, listenPort: PORT }] : ENTRY_SERVERS;
    for (const entry of envEntry) listenEntry(entry);

    // ── HTTP 管理端口 ──────────────────────────────────
    // 纯 HTTP 服务器，仅处理 /v1/local/* 管理 API，不转发代理请求。
    // 解决 Tauri 生产模式下 webview 无法访问自签名 HTTPS 的问题。
    const mgmtServer = http.createServer(function (req, res) {
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
    });
    servers.push(mgmtServer);
    mgmtServer.on('error', function (err) {
      handleListenError('management port 127.0.0.1:' + MGMT_PORT, err);
    });
    // Write the management token to disk BEFORE starting to listen so
    // dev-static-server.js (and any other reader) sees the new token the
    // moment the port is reachable. Without this, there's a small window
    // where the server is accepting connections but the token file still
    // holds the previous process's token, and any forwarded management
    // request gets 401 Unauthorized until the new token is written.
    writeManagementTokenFile(MGMT_PORT);
    mgmtServer.listen(MGMT_PORT, '127.0.0.1', function () {
      writeManagementTokenFile(MGMT_PORT);
      log.info('  Mgmt:    http://127.0.0.1:' + MGMT_PORT + '/v1/local/*  [management-http]');
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

module.exports = { startProxyServers };
