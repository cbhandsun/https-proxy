'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  buildHostedReviewPlan,
  collectClosure,
  controllerPinRecord,
} = require('../../scripts/context-hosted/build-plan');
test('both repository-owned scenario closures can be pinned without executing their entrypoints', () => {
  const repo = path.resolve(__dirname, '../..');
  for (const scenario of ['n08', 'n09']) {
    const root = path.join(repo, 'scripts/context-hosted', scenario);
    const entry = path.join(root, 'owned-entry.js');
    const composition = path.join(
      root,
      scenario === 'n08' ? 'observed-composition.js' : 'composition.js'
    );
    const dynamic =
      scenario === 'n08'
        ? [
            'context-recovery-daemon-owned-transport.js',
            'context-recovery-daemon-owned-adapter.js',
          ].map((name) => path.join(repo, 'scripts/lib', name))
        : [];
    const pins = collectClosure([entry, composition], dynamic);
    assert.match(pins[entry], /^[a-f0-9]{64}$/);
    assert.match(pins[composition], /^[a-f0-9]{64}$/);
    assert.ok(Object.keys(pins).length > 10);
    assert.equal(
      pins[path.join(repo, 'scripts/lib/nsis-installed-websocket-listener.js')],
      undefined,
      'installed-only WebSocket dependencies stay outside both core-only closures'
    );
    assert.equal(require.cache[entry], undefined);
  }
});
test('controller pins use the exact basename schema consumed by the hosted builder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n08-controller-pins-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
    const names = [
      'context-recovery-daemon-owned-controller.ps1',
      'context-recovery-daemon-owned-controller.psm1',
      'context-recovery-daemon-start-gate.cjs',
      'nsis-runtime-boundary-job.cs',
      'nsis-lifecycle.psm1',
      'nsis-runtime-boundary.psm1',
    ];
    for (const name of names) fs.writeFileSync(path.join(root, 'scripts/lib', name), name);
    const pins = controllerPinRecord(
      root,
      names.map((name) => 'scripts/lib/' + name)
    );
    assert.deepEqual(Object.keys(pins), names);
    assert.ok(Object.values(pins).every((value) => /^[a-f0-9]{64}$/.test(value)));
    assert.throws(() => controllerPinRecord(root, ['scripts/lib/missing.ps1']));
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
test('fixed candidate imports remain pinnable after multiline formatting; arbitrary dynamic paths reject', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-hosted-dynamic-'));
  try {
    const entry = path.join(root, 'observed-composition.js');
    const dynamic = [
      'context-recovery-daemon-owned-transport.js',
      'context-recovery-daemon-owned-adapter.js',
    ].map((name) => path.join(root, name));
    for (const file of dynamic) fs.writeFileSync(file, "throw Error('must never execute');");
    fs.writeFileSync(
      entry,
      "require(\n path.join(\n options.candidate,\n 'scripts/lib/context-recovery-daemon-owned-transport.js'\n )\n);\n"
    );
    assert.equal(Object.keys(collectClosure([entry], dynamic)).length, 3);
    assert.throws(() => collectClosure([entry], []));
    fs.writeFileSync(entry, "require(path.join(options.candidate, 'arbitrary.js'));");
    assert.throws(() => collectClosure([entry], dynamic));
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
test('plan generation rejects malformed and executable boundary values before filesystem work', () => {
  let touched = 0;
  for (const value of [
    null,
    [],
    {},
    new Proxy(
      {},
      {
        ownKeys() {
          touched++;
          return [];
        },
      }
    ),
    Object.defineProperty({}, 'candidate', {
      enumerable: true,
      get() {
        touched++;
        return '/x';
      },
    }),
  ]) {
    assert.throws(() => buildHostedReviewPlan(value), /^Error: context_hosted_plan_rejected$/);
  }
  assert.equal(touched, 0);
});
test('closure collection hashes lazy dependencies without executing them and refuses arbitrary imports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n08-plan-'));
  const entry = path.join(root, 'entry.cjs'),
    lazy = path.join(root, 'lazy.cjs');
  try {
    fs.writeFileSync(entry, "module.exports=()=>require('./lazy.cjs');\n");
    fs.writeFileSync(lazy, "throw new Error('must_not_execute');\n");
    assert.equal(Object.keys(collectClosure([entry], [])).length, 2);
    assert.equal(require.cache[lazy], undefined);
    for (const source of [
      "require('./missing.cjs');",
      "require('unknown-package');",
      'require(process.env.SELECTOR);',
    ]) {
      fs.writeFileSync(entry, source);
      assert.throws(() => collectClosure([entry], []));
    }
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
