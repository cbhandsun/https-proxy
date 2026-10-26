'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { discoverTestFiles } = require('../lib/test-discovery');
const {
  exerciseInstalledHttpDrain,
  exerciseInstalledHttpSseDrain,
  parseDrainOptions,
  httpDrainFailurePhase,
  HTTP_DRAIN_PHASES,
} = require('../scripts/lib/nsis-installed-http-drain');
const { createBusinessHandler } = require('../scripts/lib/nsis-installed-client-matrix');

function options(client = 'codex', mode = 'default') {
  return {
    client,
    mode,
    model: 'hpm-installed-' + client,
    entryToken: 'hpm-synthetic-' + 'a'.repeat(32),
    upstreamToken: 'hpm-upstream-' + 'b'.repeat(32),
  };
}

async function fixture(t, client, mode, fault, withSse = false) {
  const input = options(client, mode);
  const previous = { client, mode, upstreamToken: input.upstreamToken };
  const active = { current: previous };
  const sockets = new Set();
  let rejected = 0,
    requests = 0,
    stops = 0,
    observed = 0,
    delivered = 0,
    observing = false,
    endedRequests = 0;
  let releaseObservation;
  const observationReady = new Promise((resolve) => {
    releaseObservation = resolve;
  });
  const business = createBusinessHandler(active, () => {
    rejected++;
  });
  const server = http.createServer((request, response) => {
    requests++;
    assert.equal(request.headers.authorization, 'Bearer ' + input.entryToken);
    if (fault === 'early') delete active.current.beforeReply;
    if (fault === 'sse-early') delete active.current.afterPrefix;
    if (fault === 'sse-prefix') active.current.prefixBytes = 1;
    const writeHead = response.writeHead.bind(response);
    response.writeHead = (status, headers) =>
      writeHead(
        fault === 'status' ? 201 : status,
        fault === 'content-type' ? { ...headers, 'content-type': 'text/plain' } : headers
      );
    const end = response.end.bind(response);
    response.end = (bytes) => {
      delivered++;
      return end(
        fault === 'body'
          ? Buffer.from('{}')
          : fault === 'oversized'
            ? Buffer.alloc(65537)
            : fault === 'utf8'
              ? Buffer.from([255])
              : bytes
      );
    };
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      endedRequests++;
      void business.respond({
        path: request.url,
        bytes: Buffer.concat(chunks),
        response,
        authorization: client === 'codex' ? 'Bearer ' + input.upstreamToken : undefined,
        apiKey: client === 'claude' ? input.upstreamToken : undefined,
      });
      if (fault === 'observation-overlap' && endedRequests === 2) releaseObservation();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const owner = {
    identity: { entryPort: port },
    isAlive: async () => true,
    async stopNaturally() {
      stops++;
      assert.equal(delivered, 0);
      assert.equal(business.inspect().pending, withSse ? 2 : 1);
      if (fault !== 'no-listener-stop') await new Promise((resolve) => server.close(resolve));
      return {
        treeEmpty: true,
        cleanupSemantics: fault === 'forced' ? 'forced_cleanup' : 'natural_exit',
        exitCode: 0,
      };
    },
    inspectStorage: () => ({
      allWithinRoot: true,
      ...Object.fromEntries(
        ['directoryPresent', 'checkpointPresent', 'writerDatabasePresent', 'wrappedKeyPresent'].map(
          (key) => [key, fault === 'storage' ? mode !== 'enhanced' : mode === 'enhanced']
        )
      ),
    }),
  };
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    run: () =>
      (withSse ? exerciseInstalledHttpSseDrain : exerciseInstalledHttpDrain)(input, {
        owner,
        adapter: { verifyOwnedIdentity: () => fault !== 'identity' },
        active,
        observe: async () => {
          observed++;
          if (fault === 'observation-failure') throw new Error('synthetic_observation_failure');
          if (fault === 'observation-overlap') {
            if (observing) throw new Error('synthetic_mailbox_overlap');
            observing = true;
            await observationReady;
            observing = false;
          }
        },
      }),
    inspect: () => ({
      active: active.current,
      previous,
      requests,
      stops,
      rejected,
      observed,
      delivered,
      pending: business.inspect().pending,
      sockets: sockets.size,
    }),
  };
}

test('both installed protocols hold real HTTP bytes until listener stop and require natural exit and storage scope', async (t) => {
  for (const client of ['codex', 'claude'])
    for (const mode of ['default', 'enhanced']) {
      const f = await fixture(t, client, mode);
      assert.deepEqual(await f.run(), {
        treeEmpty: true,
        cleanupSemantics: 'natural_exit',
        exitCode: 0,
        httpTransportDrainQualified: true,
      });
      const state = f.inspect();
      assert.equal(state.active, state.previous);
      assert.equal(state.requests, 1);
      assert.equal(state.stops, 1);
      assert.equal(state.delivered, 1);
      assert.equal(state.pending, 0);
      assert.equal(state.rejected, 0);
      assert.equal(state.observed, mode === 'default' ? 1 : 0);
    }
});

test('early response, wrong wire/status, forced cleanup, wrong storage or unowned identity cannot qualify', async (t) => {
  for (const fault of [
    'early',
    'body',
    'oversized',
    'utf8',
    'status',
    'content-type',
    'forced',
    'storage',
    'identity',
  ]) {
    const f = await fixture(t, 'codex', 'default', fault);
    await assert.rejects(f.run(), (error) => {
      assert.equal(error.message, 'installed_http_drain_failed');
      assert.equal(
        httpDrainFailurePhase(error),
        {
          early: 'upstream_hold',
          body: 'public_response',
          oversized: 'public_response',
          utf8: 'public_response',
          status: 'public_response',
          'content-type': 'public_response',
          forced: 'natural_exit',
          storage: 'storage',
          identity: 'owner',
        }[fault]
      );
      return true;
    });
    const state = f.inspect();
    assert.equal(state.active, state.previous);
    if (fault === 'identity') assert.equal(state.requests, 0);
    if (fault === 'early') assert.equal(state.stops, 0);
  }
});

test('an exit-intent or fabricated zero-exit receipt cannot release the hold without actual listener stop', async (t) => {
  const f = await fixture(t, 'claude', 'default', 'no-listener-stop');
  const start = performance.now();
  await assert.rejects(f.run(), /^Error: installed_http_drain_failed$/);
  assert.ok(performance.now() - start >= 4900);
  assert.equal(f.inspect().delivered, 0);
  assert.equal(f.inspect().stops, 1);
});

test('drain input rejects empty, malformed, hostile, oversized and non-synthetic credentials without getters', () => {
  const input = options();
  assert.equal(parseDrainOptions(input).client, 'codex');
  let calls = 0;
  const getter = Object.defineProperty({}, 'client', {
    enumerable: true,
    get() {
      calls++;
      return 'codex';
    },
  });
  for (const value of [
    null,
    [],
    {},
    '',
    getter,
    new Proxy(input, {}),
    { ...input, extra: true },
    ...[null, '', 'openai', 'PRIVATE_KEY', 'x'.repeat(300000)].map((entryToken) => ({
      ...input,
      entryToken,
    })),
    { ...input, model: 'gpt-real-provider' },
    { ...input, mode: 'private' },
    { ...input, client: 'shell' },
  ])
    assert.throws(() => parseDrainOptions(value), /^Error: installed_http_drain_failed$/);
  assert.equal(calls, 0);
  assert.equal(Object.isFrozen(HTTP_DRAIN_PHASES), true);
  const forged = Object.defineProperty({}, 'phase', {
    get() {
      calls++;
      throw Error('PRIVATE_ERROR');
    },
  });
  for (const error of [forged, new Proxy({}, {}), Error('PRIVATE_ERROR'), null, undefined])
    assert.equal(httpDrainFailurePhase(error), null);
  assert.equal(calls, 0);
  assert.ok(
    discoverTestFiles(path.resolve(__dirname, '..')).includes(
      'test/nsis-installed-http-drain.test.js'
    )
  );
});

test('invalid entry ports are rejected before ownership probes or any network operation', async () => {
  let calls = 0;
  for (const entryPort of [null, 0, -1, 80, 65536, 1.5, NaN, Infinity, '12000']) {
    await assert.rejects(
      exerciseInstalledHttpDrain(options(), {
        owner: {
          identity: { entryPort },
          isAlive() {
            calls++;
          },
        },
        adapter: {
          verifyOwnedIdentity() {
            calls++;
            return true;
          },
        },
        active: { current: {} },
        observe: async () => {},
      }),
      (error) => httpDrainFailurePhase(error) === 'owner'
    );
  }
  assert.equal(calls, 0);
});

test('both protocols and modes receive an SSE prefix before stop and complete both transports', async (t) => {
  for (const client of ['codex', 'claude'])
    for (const mode of ['default', 'enhanced']) {
      const f = await fixture(t, client, mode, undefined, true);
      assert.deepEqual(await f.run(), {
        treeEmpty: true,
        cleanupSemantics: 'natural_exit',
        exitCode: 0,
        httpTransportDrainQualified: true,
        sseTransportDrainQualified: true,
      });
      const state = f.inspect();
      assert.equal(state.requests, 2);
      assert.equal(state.stops, 1);
      assert.equal(state.delivered, 2);
      assert.equal(state.pending, 0);
      assert.equal(state.rejected, 0);
      assert.equal(state.observed, mode === 'default' ? 2 : 0);
      assert.equal(state.active, state.previous);
    }
});

test('missing SSE hold, invalid prefix or incomplete response cannot acquire streaming qualification', async (t) => {
  for (const fault of [
    'sse-early',
    'sse-prefix',
    'body',
    'utf8',
    'oversized',
    'content-type',
    'forced',
    'storage',
  ]) {
    const f = await fixture(t, 'codex', 'default', fault, true);
    await assert.rejects(f.run(), /^Error: installed_http_drain_failed$/);
  }
});

test('concurrent JSON and SSE probes serialize the original per-request observation mailbox without retry', async (t) => {
  const f = await fixture(t, 'codex', 'default', 'observation-overlap', true);
  assert.equal((await f.run()).sseTransportDrainQualified, true);
  assert.equal(f.inspect().observed, 2);
  const broken = await fixture(t, 'codex', 'default', 'observation-failure', true);
  await assert.rejects(broken.run(), /^Error: installed_http_drain_failed$/);
  assert.equal(broken.inspect().observed, 1);
});
