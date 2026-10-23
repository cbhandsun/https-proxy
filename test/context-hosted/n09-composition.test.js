'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const {
  buildHostedLifecycle,
  prepareHostedSpawn,
} = require('../../scripts/context-hosted/n09/hosted-lifecycle.js');
const {
  closeResources,
  composeHostedN09,
} = require('../../scripts/context-hosted/n09/composition.js');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const names = [
  'n09-ipc-entry.ps1',
  'same-directory-ipc.psm1',
  'same-directory-restart.psm1',
  'n09-ipc-writer.cs',
];
test('hosted lifecycle pins the same original gate as the controller and rejects changed identities', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n09-hosted-copy-'));
  try {
    const source = path.resolve(__dirname, '../../scripts/context-hosted/n09-ipc');
    const controller = path.join(
      root,
      'n08-hosted-controller/context-recovery-daemon-owned-controller.psm1'
    );
    fs.mkdirSync(path.dirname(controller));
    fs.writeFileSync(controller, 'synthetic controller bytes');
    const candidate = path.join(root, 'candidate');
    const gate = path.join(candidate, 'scripts/lib/context-recovery-daemon-start-gate.cjs');
    fs.mkdirSync(path.dirname(gate), { recursive: true });
    fs.writeFileSync(gate, 'synthetic original gate bytes');
    const jobSource = path.join(candidate, 'scripts/lib/nsis-runtime-boundary-job.cs');
    fs.writeFileSync(jobSource, 'synthetic original job source bytes');
    const pins = Object.fromEntries(
      names.map((name) => [name, sha(fs.readFileSync(path.join(source, name)))])
    );
    const options = {
      ownedRoot: root,
      candidate,
      gateSha256: sha(fs.readFileSync(gate)),
      jobSourceSha256: sha(fs.readFileSync(jobSource)),
      sourcePins: pins,
      controllerCopySha256: sha(fs.readFileSync(controller)),
    };
    assert.throws(() => buildHostedLifecycle({ ...options, controllerCopySha256: '0'.repeat(64) }));
    assert.throws(() => buildHostedLifecycle({ ...options, gateSha256: '0'.repeat(64) }));
    for (const hash of [undefined, null, '', '0'.repeat(64), 'a'.repeat(65), {}]) {
      assert.throws(() => buildHostedLifecycle({ ...options, jobSourceSha256: hash }));
    }
    fs.unlinkSync(jobSource);
    assert.throws(() => buildHostedLifecycle(options));
    fs.writeFileSync(jobSource, 'synthetic original job source bytes');
    assert.throws(() =>
      buildHostedLifecycle({
        ...options,
        sourcePins: { ...pins, 'n09-ipc-writer.cs': '0'.repeat(64) },
      })
    );
    const result = buildHostedLifecycle(options);
    const relocated = fs.readFileSync(
      path.join(result.outputRoot, 'same-directory-restart.psm1'),
      'utf8'
    );
    assert.ok(
      relocated.includes("'" + jobSource.replaceAll("'", "''") + "'"),
      'relocated lifecycle must use the existing original Job source'
    );
    assert.equal(
      fs.existsSync(path.join(path.dirname(controller), 'nsis-runtime-boundary-job.cs')),
      false
    );
    for (const name of names) {
      const original = fs.readFileSync(path.join(source, name));
      const copy = fs.readFileSync(path.join(result.outputRoot, name));
      assert.equal(sha(copy), result.copyPins[name]);
      if (name !== 'same-directory-restart.psm1') assert.deepEqual(copy, original);
      else {
        const before =
          "$script:N09ControllerPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../scripts/lib/context-recovery-daemon-owned-controller.psm1'))";
        assert.equal(
          copy.toString(),
          original
            .toString()
            .replace(
              before,
              "$script:N09ControllerPath = '" + controller.replaceAll("'", "''") + "'"
            )
            .replace(
              "(Join-Path (Split-Path $script:N09ControllerPath) 'context-recovery-daemon-start-gate.cjs')",
              "'" + gate.replaceAll("'", "''") + "'"
            )
            .replace(
              "(Join-Path (Split-Path $script:N09ControllerPath) 'nsis-runtime-boundary-job.cs')",
              "'" + jobSource.replaceAll("'", "''") + "'"
            )
            .replace(
              "Release = { param($o) $o.process.StandardInput.Write('1'); $o.process.StandardInput.Close() }",
              `Release = { param($o)
            & $Lease.controller { param($r, $c, $p, $t, $s) Initialize-HpmN09AckBootstrap $r $c $p $t $s } $Lease.root $o.process.StartInfo.Environment['HPM_DAEMON_OWNED_CASE_ROOT'] $o.process.Id $Lease.token $Lease.manifest
            $o.process.StandardInput.Write('1'); $o.process.StandardInput.Close()
        }`
            )
            .replace(
              "    foreach ($pair in @(@('USERPROFILE', 'home')",
              "    $expected['NODE_EXTRA_CA_CERTS'] = Join-Path $Lease.root 'n08-hosted-network/ca.pem'\n    foreach ($pair in @(@('USERPROFILE', 'home')"
            )
        );
      }
    }
    assert.throws(() => buildHostedLifecycle(options));
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
test('spawn plan retains private bootstrap, fixed stdin protocol and only three hosted flags without spawning', () => {
  const saved = Object.fromEntries(
    ['GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'RUNNER_OS'].map((name) => [name, process.env[name]])
  );
  try {
    Object.assign(process.env, {
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_OS: 'Windows',
    });
    const root = path.resolve(os.tmpdir(), 'n09-owned-spawn');
    const settings = { ownedRoot: root, manifestSha256: 'a'.repeat(64) };
    const args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.resolve(__dirname, '../../scripts/context-hosted/n09-ipc/n09-ipc-entry.ps1'),
      '-OwnedRoot',
      root,
      '-InstallDirectory',
      path.join(root, 'payload'),
      '-ManifestSha256',
      settings.manifestSha256,
      '-ParentPid',
      String(process.pid),
    ];
    const env = {};
    for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP'])
      if (process.env[name]) env[name] = process.env[name];
    env.HPM_N09_BOOTSTRAP_TOKEN = 'b'.repeat(64);
    const options = { env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] };
    const executable = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    const plan = prepareHostedSpawn(settings, executable, args, options);
    assert.equal(plan.args[4], path.join(root, 'n09-hosted-lifecycle/n09-ipc-entry.ps1'));
    assert.deepEqual(
      plan.args.filter((_, index) => index !== 4),
      args.filter((_, index) => index !== 4)
    );
    assert.equal(plan.options.env.HPM_N09_BOOTSTRAP_TOKEN, env.HPM_N09_BOOTSTRAP_TOKEN);
    for (const modified of [
      { ...options, shell: true },
      { ...options, stdio: ['pipe', 'inherit', 'pipe'] },
      { ...options, env: { ...env, NODE_OPTIONS: '--require arbitrary' } },
      { ...options, env: { ...env, HPM_N09_BOOTSTRAP_TOKEN: 'bad' } },
    ])
      assert.throws(() => prepareHostedSpawn(settings, executable, args, modified));
    assert.throws(() => prepareHostedSpawn(settings, executable, [...args, '-extra'], options));
    assert.throws(() => prepareHostedSpawn(settings, 'arbitrary.exe', args, options));
    process.env.RUNNER_ENVIRONMENT = 'self-hosted';
    assert.throws(() => prepareHostedSpawn(settings, executable, args, options));
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});
test('cleanup attempts every owned resource even after failure and requires observed listener stop', async () => {
  const calls = [];
  await assert.rejects(
    closeResources(
      [
        {
          close: async () => {
            calls.push('first');
            throw Error('private');
          },
        },
        {
          close: async () => {
            calls.push('second');
          },
        },
      ],
      {
        close: async () => {
          calls.push('listener');
          return true;
        },
      }
    ),
    /^Error: n09_hosted_composition_rejected$/
  );
  assert.deepEqual(calls, ['first', 'second', 'listener']);
  await assert.rejects(closeResources([], { close: async () => false }));
  assert.deepEqual(await closeResources([{ close: async () => {} }], { close: async () => true }), {
    adaptersClosed: 1,
    listenerClosed: true,
  });
});
test('composition rejects empty, invalid, and executable boundaries before launching anything', async () => {
  let traps = 0;
  for (const input of [
    null,
    {},
    [],
    new Proxy(
      {},
      {
        ownKeys() {
          traps++;
          return [];
        },
      }
    ),
    Object.defineProperty({}, 'candidate', {
      enumerable: true,
      get() {
        traps++;
        return '/private';
      },
    }),
  ]) {
    await assert.rejects(composeHostedN09(input), /^Error: n09_hosted_composition_rejected$/);
  }
  assert.equal(traps, 0);
});
