'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const {
  validateNativeEvidenceDiagnosticAuthority,
  verifyNativeEvidenceDiagnosticPlan,
  createNativeEvidenceDiagnosticWorkload,
} = require('../scripts/lib/native-evidence-diagnostic-plan');
const {
  runNativeEvidenceDiagnostic,
} = require('../scripts/lib/native-evidence-diagnostic-runtime');

const authority = () => ({
  schema: 'hpm.context.native-evidence-diagnostic-authorization',
  version: 1,
  scope: 'one_isolated_native_retained_read_diagnostic',
  userExplicitlyAuthorized: true,
  maximumAdditionalRequests: 6,
  automaticRetries: 0,
  failedAndCompactionRequestsCounted: true,
  reusePreviouslyAuthorizedOfficialLogin: true,
  installedCodexConfigurationMayChange: false,
  productionRestartAuthorized: false,
  providerCredentialCreationAuthorized: false,
  publicationAuthorized: false,
});

test('six-request authority is explicit, zero retry, immutable-scope and bounded', () => {
  assert.deepEqual({ ...validateNativeEvidenceDiagnosticAuthority(authority()) }, authority());
  for (const field of Object.keys(authority())) {
    const value = authority();
    delete value[field];
    assert.throws(() => validateNativeEvidenceDiagnosticAuthority(value));
  }
  for (const limit of [0, 7, -1, '6', Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() =>
      validateNativeEvidenceDiagnosticAuthority({
        ...authority(),
        maximumAdditionalRequests: limit,
      })
    );
  }
  let effects = 0;
  const getter = Object.defineProperty({}, 'schema', {
    enumerable: true,
    get() {
      effects++;
      return 'secret';
    },
  });
  for (const value of [null, [], '', {}, getter, { secret: 'x'.repeat(5000) }]) {
    assert.throws(() => validateNativeEvidenceDiagnosticAuthority(value));
  }
  assert.equal(effects, 0);
});

test('existing attempt/result and malformed authority refuse before any model process', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-diagnostic-plan-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, '.hpm-runtime');
  fs.mkdirSync(runtime);
  const base = path.join(runtime, 'context-native-evidence-diagnostic-20261012-run1');
  const authPath = base + '-authorization.json';
  fs.writeFileSync(authPath, JSON.stringify(authority()));
  for (const suffix of ['-attempt.json', '-result.json']) {
    fs.writeFileSync(base + suffix, '{}');
    assert.throws(() => verifyNativeEvidenceDiagnosticPlan(root), {
      code: 'native_diagnostic_prior_run_must_be_preserved',
    });
    await assert.rejects(runNativeEvidenceDiagnostic(root), {
      code: 'native_diagnostic_prior_run_must_be_preserved',
    });
    fs.unlinkSync(base + suffix);
  }
  fs.writeFileSync(authPath, JSON.stringify({ ...authority(), maximumAdditionalRequests: 7 }));
  await assert.rejects(runNativeEvidenceDiagnostic(root), {
    code: 'native_diagnostic_authority_unconfirmed',
  });
  assert.deepEqual(fs.readdirSync(runtime), [path.basename(authPath)]);
});

test('synthetic seeding retains seven originals without oracle/real-model acceptance', () => {
  const w = createNativeEvidenceDiagnosticWorkload();
  try {
    const diagnostics = w.diagnostics();
    assert.equal(diagnostics.evidenceLedger.retainedEntries, 7);
    assert.equal(diagnostics.evidenceTools.calls, 0);
    assert.equal(w.prompts.length, 1);
    assert.equal(w.prompts[0].includes('青瓷'), false);
    const list = w.reply('hpm_list_retained_evidence', {});
    assert.equal(list.ok, true);
    const item = JSON.parse(list.text).sources[0];
    const read = w.reply('hpm_read_retained_evidence', {
      sourceId: item.sourceId,
      digest: item.digest,
      offsetBytes: 0,
      limitBytes: 8192,
    });
    assert.equal(read.ok, true);
    assert.equal(
      w.inspectReadbackInput([{ type: 'custom_tool_call_output', output: read.text }])[0].observed,
      true
    );
    assert.equal(w.diagnostics().evidenceTools.successfulReads, 1);
  } finally {
    w.close();
  }
  assert.equal(w.reply('hpm_list_retained_evidence', {}).ok, false);
});

test('fresh run2 authority cannot reuse run1 consent or an existing attempt', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-diagnostic-run2-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, '.hpm-runtime');
  fs.mkdirSync(runtime);
  const base = path.join(runtime, 'context-native-evidence-diagnostic-20261012-run2');
  const auth = {
    ...authority(),
    diagnosticRun: 'run2',
    priorDiagnosticSha256: 'adfbbac8ee092709dacad8ff32fb209416d5ba6823a0b5be083268cbca121c92',
  };
  for (const run of [null, [], {}, '', 'run4', '../run2']) {
    assert.throws(() => verifyNativeEvidenceDiagnosticPlan(root, run), {
      code: 'native_diagnostic_run_invalid',
    });
  }
  for (const value of [
    authority(),
    { ...auth, diagnosticRun: 'run1' },
    { ...auth, priorDiagnosticSha256: '0'.repeat(64) },
  ]) {
    fs.writeFileSync(base + '-authorization.json', JSON.stringify(value));
    assert.throws(() => verifyNativeEvidenceDiagnosticPlan(root, 'run2'), {
      code: 'native_diagnostic_authority_unconfirmed',
    });
  }
  fs.writeFileSync(base + '-authorization.json', JSON.stringify(auth));
  for (const suffix of ['-attempt.json', '-result.json']) {
    fs.writeFileSync(base + suffix, '{}');
    assert.throws(() => verifyNativeEvidenceDiagnosticPlan(root, 'run2'), {
      code: 'native_diagnostic_prior_run_must_be_preserved',
    });
    fs.unlinkSync(base + suffix);
  }
});

for (const run of ['run2', 'run3'])
  test(`${run} counts consumed diagnostics and refuses changed or nonterminal evidence`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-diagnostic-budget-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runtime = path.join(root, '.hpm-runtime');
    fs.mkdirSync(runtime);
    const diagnosticSha = 'adfbbac8ee092709dacad8ff32fb209416d5ba6823a0b5be083268cbca121c92';
    const write = (name, value) =>
      fs.writeFileSync(path.join(runtime, name), JSON.stringify(value));
    const hashes = {
      'context-native-evidence-v2-20261012-pair1-control-result.json':
        '43163a97217dad50c71979116323f385d798276ed778c2113368628500eee8d1',
      'context-native-evidence-v2-20261012-pair1-compact-result.json':
        '40cd4511da38ded40349a1de643b48494d1420686f7b7751a5a1a2f74a5c5cd1',
      'context-native-evidence-candidate-20261012-pair1-audit-result.json':
        '6a5fbae255e29427f83fbe8a6de0a43f16d8953c21998fd38b665a96fe4ca385',
      'context-native-evidence-diagnostic-20261012-run1-result.json': diagnosticSha,
    };
    const run2Sha = 'c0a1510c9a38df46a3c65f7278087e30b6ab9f0a5a24b59ed8991addeecb2b4a';
    const previousName = 'context-native-evidence-diagnostic-20261012-run2-result.json';
    hashes[previousName] = run2Sha;
    write('context-native-evidence-diagnostic-20261012-' + run + '-authorization.json', {
      ...authority(),
      diagnosticRun: run,
      priorDiagnosticSha256: run === 'run3' ? run2Sha : diagnosticSha,
      ...(run === 'run3' ? { productNativeGuidanceCandidate: true } : {}),
    });
    write('context-native-evidence-v2-20261012-pair1-control-result.json', {
      transport: [{}, {}],
      requestBudget: { cumulativeRequests: 34 },
    });
    write('context-native-evidence-v2-20261012-pair1-compact-result.json', {
      transport: Array.from({ length: 12 }, () => ({})),
      requestBudget: { cumulativeRequests: 52 },
    });
    write('context-native-evidence-candidate-20261012-pair1-audit-result.json', {
      protection: {
        protectedFiles: Array.from({ length: 11 }, (_, index) => ({
          path: path.join(root, 'guard-' + index),
          sha256: 'a'.repeat(64),
        })),
      },
    });
    fs.writeFileSync(path.join(root, 'proxy.config.json'), '{}');
    const prior = {
      phase: 'terminal',
      transport: [{}],
      requestBudget: { cumulativeRequests: 87 },
      nativeProcessTerminal: true,
      isolatedProxyTerminal: true,
      loopbackServerTerminal: true,
      guardedFilesUnchanged: true,
      isolatedDirectoriesRemoved: true,
    };
    const priorName = 'context-native-evidence-diagnostic-20261012-run1-result.json';
    write(priorName, prior);
    if (run === 'run3')
      write(previousName, { ...prior, requestBudget: { cumulativeRequests: 88 } });
    const file = require.resolve('../scripts/lib/native-evidence-diagnostic-plan');
    const cached = require.cache[file];
    const load = Module._load;
    let plan;
    try {
      delete require.cache[file];
      Module._load = function (id, ...args) {
        if (id === './native-evidence-v2-preflight')
          return {
            hashFile: (candidate) => hashes[path.basename(candidate)] ?? 'a'.repeat(64),
            approvedNativeEvidenceRoute: () => ({}),
          };
        return load.call(this, id, ...args);
      };
      plan = require(file);
    } finally {
      Module._load = load;
      require.cache[file] = cached;
    }
    const checked = plan.verifyNativeEvidenceDiagnosticPlan(root, run);
    assert.equal(checked.priorRequests, run === 'run3' ? 88 : 87);
    assert.equal(checked.cumulativeLimit, run === 'run3' ? 94 : 93);
    assert.equal(checked.requestLimit, 6);
    for (const field of Object.keys(prior)) {
      const value = { ...prior };
      delete value[field];
      write(priorName, value);
      assert.throws(() => plan.verifyNativeEvidenceDiagnosticPlan(root, run), {
        code: 'native_diagnostic_prior_budget_unconfirmed',
      });
    }
    write(priorName, prior);
    if (run === 'run3') {
      for (const field of Object.keys(prior)) {
        const value = { ...prior, requestBudget: { cumulativeRequests: 88 } };
        delete value[field];
        write(previousName, value);
        assert.throws(() => plan.verifyNativeEvidenceDiagnosticPlan(root, run), {
          code: 'native_diagnostic_prior_budget_unconfirmed',
        });
      }
      write(previousName, { ...prior, requestBudget: { cumulativeRequests: 88 } });
    }
    hashes[run === 'run3' ? previousName : priorName] = '0'.repeat(64);
    assert.throws(() => plan.verifyNativeEvidenceDiagnosticPlan(root, run), {
      code: 'native_diagnostic_prior_evidence_changed',
    });
  });

test('diagnostic CLI rejects implicit calls, alternate models, extra requests and retries', () => {
  for (const args of [[], ['--retry'], ['--live', '7'], ['--live', 'gpt-other']]) {
    const child = spawnSync(
      process.execPath,
      [path.resolve(__dirname, '../scripts/probe-native-evidence-diagnostic.js'), ...args],
      { encoding: 'utf8', timeout: 20000 }
    );
    assert.equal(child.status, 1);
    assert.equal(JSON.parse(child.stdout).code, 'native_diagnostic_cli_failed');
  }
});
