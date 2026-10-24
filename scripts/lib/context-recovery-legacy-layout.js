'use strict';

const path = require('node:path');
const { types, isDeepStrictEqual } = require('node:util');
const {
  safePath,
  digest,
  verifyInstallation,
  compareReceipts,
} = require('./nsis-encrypted-contract');

const {
  createOwnedRoot,
  executeDriver,
  executeWorkerDriver,
  inspectOwnedStore,
} = require('./context-recovery-legacy-layout-runtime');

const BASELINE = Object.freeze({
  manifest: '4eb1ea482224541c14e7ccddabbb94d75dd2cb698a14a78f6745f11eef43b66f',
  node: '780f44f2c53c108bae261ada21a525b4bfe733c020ac85e41bfe94479090ac9b',
  native: '515e673184e2f897d27dfca7b6e3ae4a9b238f0bc0fd1314a2520360642f945e',
});
const fail = () => new Error('context_recovery_legacy_layout_failed');
const exact = (value, names) => {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).sort().join(',') !== names.slice().sort().join(',')
  )
    throw fail();
  const result = {};
  for (const name of names) {
    const slot = Object.getOwnPropertyDescriptor(value, name);
    if (!slot.enumerable || !Object.hasOwn(slot, 'value')) throw fail();
    result[name] = slot.value;
  }
  return result;
};

function parseLegacyLayoutArguments(input) {
  try {
    if (
      types.isProxy(input) ||
      !Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Array.prototype ||
      input.length !== 3 ||
      Reflect.ownKeys(input).length !== 4
    )
      throw fail();
    const values = [0, 1, 2].map((index) => {
      const slot = Object.getOwnPropertyDescriptor(input, String(index));
      if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw fail();
      if (typeof slot.value !== 'string' || slot.value.length > 4096) throw fail();
      return slot.value;
    });
    const [baseline, current, manifestSha256] = values;
    for (const directory of [baseline, current])
      if (
        !path.isAbsolute(directory) ||
        /^[\\/]{2}/.test(directory) ||
        /[\0\r\n]/.test(directory) ||
        path.resolve(directory) !== directory
      )
        throw fail();
    if (
      baseline.toLowerCase() === current.toLowerCase() ||
      !/^[a-f0-9]{64}$/.test(manifestSha256) ||
      manifestSha256 === BASELINE.manifest
    )
      throw fail();
    return { baseline, current, manifestSha256 };
  } catch {
    throw fail();
  }
}

function verifyPackages(
  request,
  { verify = verifyInstallation, hash = digest, checkedPath = safePath } = {}
) {
  const baseline = verify(request.baseline, BASELINE.manifest);
  const current = verify(request.current, request.manifestSha256);
  if (
    baseline.sourceCount !== 582 ||
    hash(baseline.node) !== BASELINE.node ||
    hash(baseline.native) !== BASELINE.native ||
    checkedPath(request.baseline, true).toLowerCase() ===
      checkedPath(request.current, true).toLowerCase()
  )
    throw fail();
  return { baseline, current };
}

function validateDriverReceipt(input, installation, refusal) {
  const value = exact(input, ['manifestSha256', 'nativeCalls', 'receipt', 'sourceCount']);
  if (
    value.manifestSha256 !== installation.manifestSha256 ||
    value.sourceCount !== installation.sourceCount ||
    !Number.isSafeInteger(value.nativeCalls) ||
    value.nativeCalls < 1 ||
    value.nativeCalls > 4
  )
    throw fail();
  return validateRecoveryReceipt(value.receipt, refusal);
}

function validateRecoveryReceipt(input, refusal) {
  if (refusal) {
    const receipt = exact(input, ['refused', 'preserved', 'statusCode', 'fileCount']);
    if (
      receipt.refused !== true ||
      receipt.preserved !== true ||
      receipt.statusCode !== 503 ||
      !Number.isSafeInteger(receipt.fileCount) ||
      receipt.fileCount < 3 ||
      receipt.fileCount > 16
    )
      throw fail();
  } else compareReceipts(input, input);
  return input;
}

function validateWorkerReceipt(input, installation, refusal, role) {
  const value = exact(input, [
    'backend',
    'observation',
    'receipt',
    'sourceCount',
    'manifestSha256',
  ]);
  if (
    value.backend !== 'default-worker' ||
    value.sourceCount !== installation.sourceCount ||
    value.manifestSha256 !== installation.manifestSha256
  )
    throw fail();
  const observation = exact(value.observation, [
    'workerStarted',
    'nativeKeyCompleted',
    'databaseOpened',
    'engineReady',
    'ready',
    'refused',
    'anchorOpened',
    'anchorPersisted',
  ]);
  const expected = {
    workerStarted: true,
    nativeKeyCompleted: true,
    databaseOpened: true,
    engineReady: !refusal,
    ready: !refusal,
    refused: refusal,
    anchorOpened: role === 'current',
    anchorPersisted: role === 'current' && !refusal,
  };
  if (!isDeepStrictEqual(observation, expected)) throw fail();
  return validateRecoveryReceipt(value.receipt, refusal);
}

function runLegacyLayoutQualification(args, dependencies = {}) {
  return runQualification(args, dependencies, false);
}
function runLegacyWorkerLayoutQualification(args, dependencies = {}) {
  return runQualification(args, dependencies, true);
}

// Dependencies are a local unit-test boundary; the CLI passes no overrides.
function runQualification(args, dependencies, worker) {
  try {
    const request = parseLegacyLayoutArguments(args);
    const platform = dependencies.platform ?? process.platform;
    if (platform !== 'win32') throw fail();
    const verify = dependencies.verify ?? verifyPackages;
    const create = dependencies.create ?? createOwnedRoot;
    const execute = dependencies.execute ?? (worker ? executeWorkerDriver : executeDriver);
    const inspect = dependencies.inspect ?? inspectOwnedStore;
    const onProgress = dependencies.onProgress ?? (() => {});
    if (typeof onProgress !== 'function' || types.isProxy(onProgress)) throw fail();
    let packages = verify(request);
    const initial = packages;
    const owned = create(); // No caller can supply a database directory.
    const check = () => {
      owned.verify();
      packages = verify(request);
      if (!isDeepStrictEqual(packages, initial)) throw fail();
    };
    const receipts = [];
    let baselineReceipt, before, after;
    for (const [role, operation] of [
      ['baseline', 'seed'],
      ['baseline', 'read'],
      ['current', 'refuse-legacy'],
      ['current', 'enroll-legacy'],
      ['current', 'resave'],
      ['current', 'read'],
      ['baseline', 'refuse-new-format'],
      ['current', 'read'],
    ]) {
      if (onProgress({ stage: receipts.length + 1, role, operation }) !== undefined) throw fail();
      check();
      const receipt = (worker ? validateWorkerReceipt : validateDriverReceipt)(
        execute({ installation: packages[role], install: request[role], operation, owned }),
        packages[role],
        operation.startsWith('refuse-'),
        role
      );
      check();
      if (!operation.startsWith('refuse-')) {
        if (!baselineReceipt) baselineReceipt = receipt;
        compareReceipts(baselineReceipt, receipt);
        if (receipt.expiresAt <= Date.now()) throw fail();
      }
      const state = exact(inspect(owned), [
        'schemaVersion',
        'hasBlobs',
        'blobs',
        'revision',
        'createdAt',
        'expiresAt',
      ]);
      if (
        Object.values(state).some((n) => !Number.isSafeInteger(n) || n < 0) ||
        state.expiresAt !== baselineReceipt.expiresAt ||
        state.revision < 1 ||
        state.createdAt >= state.expiresAt
      )
        throw fail();
      if (receipts.length < 3) {
        if (
          state.schemaVersion !== 1 ||
          state.hasBlobs !== 0 ||
          state.blobs !== 0 ||
          state.revision !== 1
        )
          throw fail();
        if (before && !isDeepStrictEqual(before, state)) throw fail();
        before = state;
      } else {
        if (
          state.schemaVersion !== 3 ||
          state.hasBlobs !== 1 ||
          state.createdAt !== before.createdAt ||
          state.revision !== before.revision + (receipts.length >= 4 ? 1 : 0) ||
          (receipts.length >= 4 && state.blobs < 1) ||
          (after && receipts.length >= 5 && !isDeepStrictEqual(after, state))
        )
          throw fail();
        after = state;
      }
      receipts.push(operation);
    }
    return {
      schemaVersion: 1,
      scope: worker
        ? 'packaged_runtime_default_worker_legacy_layout_migration'
        : 'packaged_runtime_legacy_layout_migration',
      passed: true,
      stages: receipts.length,
      baselineSourceCount: 582,
      baselineManifestSha256: BASELINE.manifest,
      currentManifestSha256: request.manifestSha256,
      modelRequests: 0,
      layoutBefore: 1,
      layoutAfter: 3,
      revisionDelta: 1,
      nsisQualified: false,
      workerQualified: worker,
      retention24hQualified: false,
      clientQualified: false,
    };
    // Preserve the newly created synthetic directory for local diagnostics. No
    // path, original, scope, key, native reply or database digest leaves here.
  } catch {
    throw fail();
  }
}

module.exports = {
  BASELINE,
  parseLegacyLayoutArguments,
  verifyPackages,
  runLegacyLayoutQualification,
  runLegacyWorkerLayoutQualification,
};
