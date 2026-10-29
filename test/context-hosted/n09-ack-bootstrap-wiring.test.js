'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { collectClosure } = require('../../scripts/context-hosted/build-plan');
const {
  buildN09AckController,
} = require('../../scripts/context-hosted/n09-ack/bootstrap-controller');
const {
  createN09BootstrapContract,
} = require('../../scripts/context-hosted/n09-ack/bootstrap-contract');
const { verifyN09Bootstrap } = require('../../scripts/lib/context-recovery-daemon-start-gate.cjs');
const candidate = path.resolve(__dirname, '../..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const relative = 'scripts/context-hosted/n09-ack/';
const token = 'b'.repeat(64);
const manifestSha256 = 'c'.repeat(64);
const safe = (error) =>
  ['daemon_start_gate_rejected', 'n09_host_ack_rejected'].includes(error.message) && !error.cause;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'n09-bootstrap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const caseRoot = path.join(root, 'case');
  fs.mkdirSync(caseRoot);
  const runtime = {
    pid: 123,
    env: {
      HPM_DAEMON_OWNED_CASE_ROOT: caseRoot,
      HPM_DAEMON_OWNED_INSTALL: path.join(root, 'payload'),
      HPM_DAEMON_OWNED_MANIFEST: manifestSha256,
      MGMT_TOKEN: token,
    },
  };
  const loadedPins = collectClosure(
    ['host-install.js', 'bootstrap-contract.js'].map((name) =>
      path.join(candidate, relative, name)
    ),
    []
  );
  const writer = path.join(candidate, relative, 'write-bootstrap.psm1');
  loadedPins[writer] = hash(fs.readFileSync(writer));
  const sourcePins = Object.fromEntries(
    Object.entries(loadedPins)
      .filter(([file]) => file !== writer)
      .map(([file, sha]) => [path.relative(candidate, file).split(path.sep).join('/'), sha])
  );
  const contract = createN09BootstrapContract({ token, pid: 123, manifestSha256 });
  t.after(() => contract.close());
  const payload = { version: 1, pid: 123, epoch: 'd'.repeat(32), manifestSha256, sourcePins };
  function write(value) {
    const directory = path.join(caseRoot, 'n09-ack');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'bootstrap-123.json'), JSON.stringify(value));
  }
  return { root, caseRoot, runtime, loadedPins, contract, payload, write };
}

test('gate keeps absent plan passive and verifies a full signed closure without loading the host', (t) => {
  const f = fixture(t);
  const host = path.join(candidate, relative, 'host-install.js');
  assert.equal(require.cache[host], undefined);
  assert.equal(verifyN09Bootstrap(f.runtime), null);
  fs.mkdirSync(path.join(f.caseRoot, 'n09-ack'));
  assert.throws(() => verifyN09Bootstrap(f.runtime), safe);
  f.write(f.contract.sign(f.payload));
  const result = verifyN09Bootstrap(f.runtime);
  assert.equal(result.signingKey, f.contract.mailboxKey(f.payload));
  assert.equal(result.pid, 123);
  assert.equal(require.cache[host], undefined);
  assert.equal(
    fs.readFileSync(path.join(f.caseRoot, 'n09-ack/bootstrap-123.json'), 'utf8').includes(token),
    false
  );
  assert.throws(() => verifyN09Bootstrap({ ...f.runtime, pid: 124 }), safe);
});

test('gate rejects signed incomplete closures, source drift, malformed wire and foreign identity', (t) => {
  const f = fixture(t);
  for (const payload of [
    {
      ...f.payload,
      sourcePins: {
        [relative + 'host-install.js']: f.payload.sourcePins[relative + 'host-install.js'],
        [relative + 'bootstrap-contract.js']:
          f.payload.sourcePins[relative + 'bootstrap-contract.js'],
      },
    },
    {
      ...f.payload,
      sourcePins: { ...f.payload.sourcePins, [relative + 'host-install.js']: '0'.repeat(64) },
    },
  ]) {
    f.write(f.contract.sign(payload));
    assert.throws(() => verifyN09Bootstrap(f.runtime), safe);
  }
  for (const wire of [null, {}, { payload: f.payload, signature: '0'.repeat(64) }]) {
    f.write(wire);
    assert.throws(() => verifyN09Bootstrap(f.runtime), safe);
  }
  f.write(f.contract.sign(f.payload));
  assert.throws(
    () =>
      verifyN09Bootstrap({ ...f.runtime, env: { ...f.runtime.env, MGMT_TOKEN: 'e'.repeat(64) } }),
    safe
  );
  assert.throws(
    () =>
      verifyN09Bootstrap({
        ...f.runtime,
        env: { ...f.runtime.env, HPM_DAEMON_OWNED_MANIFEST: 'e'.repeat(64) },
      }),
    safe
  );
});

test('gate rejects hardlinked plans, oversized input and noncanonical bytes', (t) => {
  const f = fixture(t);
  const envelope = f.contract.sign(f.payload);
  f.write(envelope);
  const file = path.join(f.caseRoot, 'n09-ack/bootstrap-123.json');
  const linked = path.join(f.caseRoot, 'second-link');
  fs.linkSync(file, linked);
  assert.throws(() => verifyN09Bootstrap(f.runtime), safe);
  fs.unlinkSync(linked);
  for (const bytes of [
    Buffer.alloc(131073, 32),
    Buffer.from(JSON.stringify(envelope) + '\n'),
    Buffer.from([255]),
  ]) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => verifyN09Bootstrap(f.runtime), safe);
  }
});

test('copied controller writes a PowerShell-signed plan before grant and gate derives its private mailbox key', (t) => {
  const f = fixture(t);
  const outputRoot = path.join(f.root, 'n08-hosted-controller');
  fs.mkdirSync(outputRoot);
  const file = path.join(outputRoot, 'context-recovery-daemon-owned-controller.psm1');
  const original =
    "function Synthetic {\n    $owner.assigned = $true\n    $State.startStage = 'gate_release'\n    $process.StandardInput.Write('1')\n}\n";
  fs.writeFileSync(file, original);
  const input = {
    candidate,
    controller: { outputRoot, copyPins: { [path.basename(file)]: hash(original) } },
    loadedPins: f.loadedPins,
    manifestSha256,
  };
  let traps = 0;
  assert.throws(
    () =>
      buildN09AckController({
        ...input,
        loadedPins: new Proxy(
          {},
          {
            get() {
              traps++;
            },
          }
        ),
      }),
    safe
  );
  assert.equal(traps, 0);
  assert.throws(
    () =>
      buildN09AckController({
        ...input,
        loadedPins: {
          ...f.loadedPins,
          [path.join(candidate, relative, 'write-bootstrap.psm1')]: '0'.repeat(64),
        },
      }),
    safe
  );
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  const copy = buildN09AckController(input);
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(hash(source), copy.copyPins[path.basename(file)]);
  const call = source.indexOf('    Initialize-HpmN09AckBootstrap');
  assert.ok(call > source.indexOf('$owner.assigned = $true'));
  assert.ok(call < source.indexOf("$process.StandardInput.Write('1')"));
  assert.equal(source.includes(token), false);
  const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
  const mock = [
    "$ErrorActionPreference = 'Stop'",
    "$env:GITHUB_ACTIONS='true'; $env:RUNNER_ENVIRONMENT='github-hosted'; $env:RUNNER_OS='Windows'",
    'function Assert-HpmLifecycleArtifactPath { param($Root, $Path, $Kind) if (-not (Test-Path -LiteralPath $Path)) { throw "mock_path_rejected" } }',
    'function Assert-HpmLifecycleChildPath { param($Root, $Path) }',
    source.slice(source.indexOf('# Loaded only as pinned source')),
    `Initialize-HpmN09AckBootstrap ${literal(f.root)} ${literal(f.caseRoot)} 123 ${literal(token)} ${literal(manifestSha256)}`,
  ].join('\n');
  const script = path.join(f.root, 'mock-writer.ps1');
  fs.writeFileSync(script, mock);
  const child = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 4096,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, 'mocked PowerShell bootstrap writer failed');
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
  const envelope = JSON.parse(
    fs.readFileSync(path.join(f.caseRoot, 'n09-ack/bootstrap-123.json'), 'utf8')
  );
  const payload = f.contract.verify(envelope);
  assert.equal(verifyN09Bootstrap(f.runtime).signingKey, f.contract.mailboxKey(payload));
  const again = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 4096,
  });
  assert.notEqual(again.status, 0);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.caseRoot, 'n09-ack/bootstrap-123.json'), 'utf8')),
    envelope
  );
});

test('the signed closure includes cancellation hooks and rejects omission or a foreign dynamic importer', (t) => {
  const f = fixture(t);
  const hook = 'scripts/context-hosted/n09-business/publication-action-hook.js';
  assert.match(f.payload.sourcePins[hook], /^[a-f0-9]{64}$/);
  const { [hook]: omitted, ...sourcePins } = f.payload.sourcePins;
  assert.ok(omitted);
  f.write(f.contract.sign({ ...f.payload, sourcePins }));
  assert.throws(() => verifyN09Bootstrap(f.runtime), safe);
  const foreign = path.join(f.root, 'foreign.js');
  fs.writeFileSync(
    foreign,
    "const path=require('node:path');require(path.join(options.install,'lib/proxy/context-recovery-publication.js'));"
  );
  assert.throws(() => collectClosure([foreign], []), { message: 'context_hosted_plan_rejected' });
});
