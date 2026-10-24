'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = path.resolve(__dirname, '../scripts/lib/nsis-installed-client-case.js');
function fixture(t, client, mode, fault) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-case-composition-'));
  fs.mkdirSync(path.join(root, 'cases'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trace = [],
    active = { current: null };
  let observations = 0,
    closed = 0,
    sourceCalls = 0;
  const state = {
    requests: 0,
    requestCount: 0,
    failed: false,
    completed: true,
    allRequestsStreaming: true,
    defaultNoPrivateTools: mode === 'default',
    complete: true,
    sourceObserved: true,
    sourceCalls: 1,
    compactions: 3,
    summaries: 0,
    readPages: mode === 'enhanced' ? 1 : 0,
    exactRead: mode === 'enhanced',
    publicEvidence: mode === 'enhanced',
    classifiedCompactions: 3,
    exactPrivateRead: mode === 'enhanced',
    independentPublicGeneration: mode === 'enhanced',
    exactAuthorizedEvidenceInPublicRequest: mode === 'enhanced',
  };
  const owner = {
    identity: { configDir: path.join(root, 'cases/daemon/config'), pid: 41, entryPort: 12001 },
    isAlive: async () => fault !== 'dead',
  };
  const adapter = { verifyOwnedIdentity: (actual) => actual === owner && fault !== 'identity' };
  const observer = async (input) => {
    assert.equal(input.caseRoot, path.join(root, 'cases/daemon'));
    assert.equal(input.sequence, ++observations);
    assert.equal(input.pid, 41);
    assert.equal(input.token, 'management-token');
    trace.push('observe');
    return {
      roots: fault === 'root' ? 1 : mode === 'enhanced' ? 2 : 0,
      snapshots: fault === 'snapshot' ? 1 : 0,
      enabled: mode === 'enhanced',
      closed: fault === 'closed',
      factoryCalls: ['factory', 'cold'].includes(fault) ? 0 : 1,
      coldDisabled: fault === 'cold',
    };
  };
  const upstream = {
    inspect: () => state,
    setPhase: (phase) => {
      trace.push(phase);
    },
    recordSourceCall: () => {
      sourceCalls++;
    },
  };
  const protocol = async (input) => {
    trace.push('protocol');
    assert.equal(active.current.upstream, upstream);
    assert.equal(input.mode, mode);
    assert.equal(input.entryUrl, 'http://127.0.0.1:12001' + (client === 'codex' ? '/v1' : ''));
    assert.match(input.entryToken, /^hpm-synthetic-[a-f0-9]{32}$/);
    input.onProgress({ phase: 'seed' });
    if (client === 'claude') {
      assert.equal(input.sourceUrl, 'http://127.0.0.1:12002/synthetic-original');
      upstream.recordSourceCall();
      const witness = await input.inspectWitness();
      assert.equal(witness.fullCoreEntrypointVerified, true);
      assert.equal(witness.defaultZeroRecovery, mode === 'default');
    }
    if (fault === 'protocol') throw new Error('secret raw response');
    if (fault === 'invalid-progress') input.onProgress({ phase: 'secret raw response' });
    if (fault && typeof fault === 'object' && Object.hasOwn(fault, 'progress'))
      input.onProgress({ phase: fault.progress });
    if (fault === 'private') state.exactRead = state.exactPrivateRead = false;
    if (fault === 'public') state.publicEvidence = state.independentPublicGeneration = false;
    if (fault === 'replay') state.sourceCalls = 2;
    if (fault === 'failed') state.failed = true;
    if (fault === 'compactions') state.compactions = state.classifiedCompactions = 2;
    if (fault === 'default-read') {
      state.readPages = 1;
      state.defaultNoPrivateTools = false;
    }
    if (fault === 'final') return {};
    return { exactFinalAnswer: true, compactions: 3, protocolPassed: true };
  };
  const overrides = {
    './nsis-client-codex': {
      runInstalledCodexCase: protocol,
      createCodexSyntheticSource: () => ({ marker: 'fixture-marker', text: 'Synthetic original' }),
    },
    './nsis-client-claude': { runInstalledClaudeCase: protocol },
    './nsis-client-codex-upstream': { createCodexSyntheticUpstream: () => upstream },
    './nsis-client-claude-upstream': { createClaudeSyntheticUpstream: () => upstream },
    './nsis-client-owned-transport': {
      createInstalledClientSpawn: (input) => {
        assert.equal(input.client, client);
        assert.equal(input.ownedRoot, root);
        return () => {
          throw new Error('unexpected uncontrolled process');
        };
      },
    },
    './nsis-client-observer.cjs': { requestInstalledClientObservation: observer },
    './nsis-client-configuration': {
      configureInstalledClient: async (actual, input) => {
        trace.push('configure');
        assert.equal(actual, owner);
        assert.equal(input.client, client);
        assert.equal(input.mode, mode);
        assert.notEqual(input.entryToken, input.upstreamToken);
        if (fault === 'config') throw new Error('secret config');
      },
    },
    './nsis-client-loopback': {
      assertEntryRefuses: async (actual, selected) => {
        trace.push('auth');
        assert.equal(actual, owner);
        assert.equal(selected, client);
        if (fault === 'auth') throw new Error('secret auth');
        if (fault === 'unauth-upstream') state.requests = state.requestCount = 1;
      },
      createSyntheticSourceServer: async (text, callback) => {
        assert.match(text, /^Synthetic original/);
        return {
          url: 'http://127.0.0.1:12002/synthetic-original',
          inspect: () => ({ calls: sourceCalls, failed: fault === 'source' }),
          close: async () => {
            closed++;
            assert.equal(active.current, null);
            callback();
            if (fault === 'close-throw') throw new Error('secret cleanup');
            return fault !== 'close-false';
          },
        };
      },
    },
  };
  const loaded = { exports: {} },
    requireActual = createRequire(filename);
  vm.runInThisContext(
    '(function(require,module,exports,__dirname){' + fs.readFileSync(filename, 'utf8') + '\n})',
    { filename }
  )(
    (name) => overrides[name] || requireActual(name),
    loaded,
    loaded.exports,
    path.dirname(filename)
  );
  return {
    run: () =>
      loaded.exports.runInstalledClientCase({
        client,
        mode,
        owner,
        adapter,
        ownedRoot: root,
        install: path.join(root, 'payload'),
        manifestSha256: 'a'.repeat(64),
        binarySha256: 'b'.repeat(64),
        powershellExecutable: 'owned-pwsh',
        token: 'management-token',
        active,
        onPhase: (phase) => trace.push(phase),
      }),
    trace,
    active,
    closed: () => closed,
  };
}
test('four case composition configures authenticated entry and uses independent runtime observations', async (t) => {
  for (const client of ['codex', 'claude'])
    for (const mode of ['default', 'enhanced']) {
      const f = fixture(t, client, mode);
      assert.deepEqual(await f.run(), {
        client,
        mode,
        compactions: 3,
        exactFinalAnswer: true,
        defaultZeroRecovery: mode === 'default',
        privateRead: mode === 'enhanced',
        publicGeneration: mode === 'enhanced',
      });
      assert.equal(f.active.current, null);
      assert.equal(f.closed(), client === 'claude' ? 1 : 0);
      assert.ok(f.trace.indexOf('auth') < f.trace.indexOf('protocol'));
      assert.ok(f.trace.indexOf('observe') < f.trace.indexOf('protocol'));
    }
});
test('default case cannot qualify with roots snapshots closed or absent runtime factory', async (t) => {
  for (const client of ['codex', 'claude'])
    for (const fault of ['root', 'snapshot', 'closed', 'factory', 'default-read']) {
      const f = fixture(t, client, 'default', fault);
      await assert.rejects(f.run(), { message: 'installed_client_case_failed' });
      assert.equal(f.active.current, null);
    }
});
test('real entry identity auth recovery and cleanup failures cannot become successful receipts', async (t) => {
  for (const client of ['codex', 'claude'])
    for (const fault of [
      'config',
      'auth',
      'unauth-upstream',
      'dead',
      'identity',
      'protocol',
      'private',
      'public',
      'replay',
      'failed',
      'compactions',
      'final',
    ]) {
      const f = fixture(t, client, 'enhanced', fault);
      await assert.rejects(f.run(), { message: 'installed_client_case_failed' });
      assert.equal(f.active.current, null);
    }
  for (const fault of ['source', 'close-false', 'close-throw']) {
    const f = fixture(t, 'claude', 'enhanced', fault);
    await assert.rejects(f.run(), { message: 'installed_client_case_failed' });
    assert.equal(f.closed(), 1);
  }
});

test('default client cases accept independently attested cold runtime without requiring recovery initialization', async (t) => {
  for (const client of ['codex', 'claude']) {
    const f = fixture(t, client, 'default', 'cold');
    assert.equal((await f.run()).defaultZeroRecovery, true);
  }
});

test('CLI failure retains the last finite turn phase without disclosing the exception', async (t) => {
  for (const client of ['codex', 'claude']) {
    const f = fixture(t, client, 'default', 'protocol');
    await assert.rejects(f.run(), { message: 'installed_client_case_failed' });
    assert.equal(
      f.trace.filter((value) => value.startsWith(client + '-default-')).at(-1),
      client + '-default-cli-seed'
    );
    assert.equal(
      f.trace.some((value) => value.includes('secret')),
      false
    );
    assert.equal(f.active.current, null);
  }
});

test('unknown CLI progress is refused without writing arbitrary phase content', async (t) => {
  for (const client of ['codex', 'claude']) {
    for (const fault of [
      'invalid-progress',
      ...['', null, undefined, 3, [], {}, 'compact-0', 'compact-4', 'x'.repeat(16384)].map(
        (progress) => ({ progress })
      ),
    ]) {
      const f = fixture(t, client, 'default', fault);
      await assert.rejects(f.run(), { message: 'installed_client_case_failed' });
      assert.equal(
        f.trace.some((value) => value.includes('secret')),
        false
      );
      assert.equal(f.active.current, null);
    }
  }
});
