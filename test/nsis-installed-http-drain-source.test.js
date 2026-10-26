'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { findAvailablePorts } = require('./helpers/test-ports');
const { waitForProxyFixtureReady } = require('./helpers/proxy-fixture-ready');
const { createBusinessHandler } = require('../scripts/lib/nsis-installed-client-matrix');
const {
  createDaemonManagementHttpClient,
} = require('../scripts/lib/context-recovery-daemon-http-client');
const {
  completeDaemonNaturalStop,
} = require('../scripts/lib/context-recovery-daemon-natural-stop');
const {
  exerciseInstalledHttpDrain,
  httpDrainFailurePhase,
} = require('../scripts/lib/nsis-installed-http-drain');

// A portable actual-main proof for the new acceptance transport. This does not
// substitute for installed Windows/native persistence or owned Job qualification.
for (const client of ['codex', 'claude']) {
  test(
    'actual isolated source ' +
      client +
      ' drains a held authenticated HTTP request before zero exit',
    { timeout: 30000 },
    async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-http-drain-source-'));
      const base = {};
      for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP'])
        if (process.env[key]) base[key] = process.env[key];
      const env = createIsolatedTestEnv(base, root);
      const input = {
        client,
        mode: 'default',
        model: 'hpm-installed-' + client,
        entryToken: 'hpm-synthetic-' + 'a'.repeat(32),
        upstreamToken: 'hpm-upstream-' + 'b'.repeat(32),
      };
      const active = { current: { client, mode: 'default', upstreamToken: input.upstreamToken } };
      let rejected = 0,
        requests = 0,
        upstreamPhase = 'unobserved';
      const business = createBusinessHandler(active, () => {
        rejected++;
      });
      const upstreamSockets = new Set();
      const upstream = http.createServer((request, response) => {
        requests++;
        const chunks = [];
        let bytes = 0;
        request.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 65536) request.destroy();
          else chunks.push(chunk);
        });
        request.on('error', () => response.destroy());
        request.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks));
            upstreamPhase =
              body.stream !== false
                ? 'stream'
                : body.model !== input.model
                  ? 'model'
                  : !JSON.stringify(client === 'codex' ? body.input : body.messages).includes(
                        'HPM_INSTALLED_HTTP_DRAIN_REQUEST'
                      )
                    ? 'input'
                    : client === 'codex'
                      ? request.headers.authorization === 'Bearer ' + input.upstreamToken &&
                        request.headers['x-api-key'] === undefined
                        ? 'validated'
                        : 'auth'
                      : request.headers['x-api-key'] === input.upstreamToken &&
                          request.headers.authorization === undefined
                        ? 'validated'
                        : 'auth';
          } catch {
            upstreamPhase = 'json';
          }
          if (
            client === 'claude' &&
            !['/v1/messages', '/v1/messages?beta=true'].includes(request.url)
          )
            upstreamPhase =
              request.url === '/messages'
                ? 'route_missing_version'
                : request.url === '/v1/v1/messages'
                  ? 'route_double_version'
                  : 'route_other';
          void business.respond({
            path: request.url,
            response,
            bytes: Buffer.concat(chunks),
            authorization: request.headers.authorization,
            apiKey: request.headers['x-api-key'],
          });
        });
      });
      upstream.on('connection', (socket) => {
        upstreamSockets.add(socket);
        socket.once('close', () => upstreamSockets.delete(socket));
      });
      await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const owned = { child: null, closed: null };
      t.after(async () => {
        if (owned.child && owned.child.exitCode === null && owned.child.signalCode === null)
          owned.child.kill('SIGKILL');
        if (owned.closed) await owned.closed;
        for (const socket of upstreamSockets) socket.destroy();
        await new Promise((resolve) => upstream.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
      });
      const [entryPort, managementPort] = await findAvailablePorts(2);
      const protocol = client === 'codex' ? 'openai-responses' : 'claude';
      const entry = {
        host: '127.0.0.1',
        listenPort: entryPort,
        protocol,
        basePath: '/v1',
        tls: false,
      };
      fs.mkdirSync(env.PROXY_CONFIG_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(env.PROXY_CONFIG_DIR, 'proxy.config.json'),
        JSON.stringify({
          activeProfile: 'synthetic',
          profiles: [
            {
              id: 'synthetic',
              name: 'synthetic',
              protocol: client === 'codex' ? 'openai' : 'claude',
              authMode: 'api-key',
              targetUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1',
              apiKey: input.upstreamToken,
            },
          ],
          modelRoutes: [],
          localServer: { ...entry, managementPort },
          entryServers: [entry],
          entryAuth: {
            enabled: true,
            keys: [
              {
                id: 'synthetic',
                key: input.entryToken,
                enabled: true,
                allowedEntryProtocols: [protocol],
                allowedEntryPorts: [entryPort],
                allowedProfileIds: ['synthetic'],
              },
            ],
          },
          appSettings: {
            contextRecoveryEnabled: false,
            contextRecoveryPersistenceEnabled: false,
            conversationAuditEnabled: false,
            conversationAuditCaptureContent: false,
            upstreamWarmupEnabled: false,
            antigravityCredentialWatchdogEnabled: false,
          },
        })
      );
      const child = spawn(process.execPath, [path.resolve('openai-proxy.js')], {
        cwd: path.resolve('.'),
        env: { ...env, MGMT_TOKEN: 'x'.repeat(32), MGMT_PORT: String(managementPort) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      owned.child = child;
      const closed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      owned.closed = closed;
      child.stderr.resume();
      await waitForProxyFixtureReady(child);
      child.stdout.resume();
      const management = createDaemonManagementHttpClient({
        port: managementPort,
        token: 'x'.repeat(32),
      });
      const health = await management({ method: 'GET', route: '/v1/local/health' });
      assert.equal(health.body.pid, child.pid);
      const owner = {
        identity: { entryPort },
        isAlive: async () => child.exitCode === null && child.signalCode === null,
        stopNaturally: () =>
          completeDaemonNaturalStop(
            { case: '00', pid: child.pid, shutdown: health.body.shutdown },
            management,
            async (request) => {
              assert.deepEqual(request, { op: 'reap', case: '00' });
              assert.deepEqual(await closed, { code: 0, signal: null });
              return {
                v: 1,
                id: 1,
                ...request,
                ok: true,
                treeEmpty: true,
                cleanupSemantics: 'natural_exit',
                exitCode: 0,
              };
            }
          ),
        inspectStorage: () => {
          const directory = path.join(env.PROXY_RUNTIME_DIR, 'context-recovery-v1');
          assert.equal(fs.existsSync(directory), false);
          return {
            allWithinRoot: true,
            directoryPresent: false,
            checkpointPresent: false,
            writerDatabasePresent: false,
            wrappedKeyPresent: false,
          };
        },
      };
      assert.equal(
        (
          await exerciseInstalledHttpDrain(input, {
            owner,
            adapter: { verifyOwnedIdentity: (value) => value === owner && child.exitCode === null },
            active,
            observe: async () => {},
          }).catch((error) => {
            t.diagnostic(
              JSON.stringify({
                phase: httpDrainFailurePhase(error),
                requests,
                rejected,
                upstreamPhase,
                processAlive: child.exitCode === null && child.signalCode === null,
              })
            );
            throw error;
          })
        ).httpTransportDrainQualified,
        true
      );
      assert.deepEqual(await closed, { code: 0, signal: null });
      assert.equal(requests, 1);
      assert.equal(rejected, 0);
      assert.equal(business.inspect().pending, 0);
    }
  );
}
