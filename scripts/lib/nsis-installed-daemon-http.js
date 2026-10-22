'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safePath } = require('./nsis-encrypted-contract');
const {
  parseRuntimeBoundaryArguments,
  verifyRuntimeBoundaryInstallation,
} = require('./nsis-runtime-boundary-contract');
const { dataSnapshot } = require('./context-recovery-daemon-http-boundary');
const { startDaemonOwnedController } = require('./context-recovery-daemon-owned-transport');
const { createDaemonOwnedAdapter } = require('./context-recovery-daemon-owned-adapter');
const { runDaemonHttpSettingsMatrix } = require('./context-recovery-daemon-http-matrix');
const fail = () => new Error('installed_daemon_http_failed');
const LABELS = ['00', '01', '10', '11'];

function parseInstalledHttpArguments(input) {
  try {
    const args = dataSnapshot(input, 'installed_daemon_http_failed');
    if (!Array.isArray(args) || args.length !== 5) throw fail();
    const [ownedRoot, install, caseRoot, manifestSha256, powershellExecutable] = args;
    const request = parseRuntimeBoundaryArguments([
      'settings-matrix',
      install,
      caseRoot,
      manifestSha256,
    ]);
    for (const value of [ownedRoot, powershellExecutable]) {
      // Reuse the strict lexical path parser without accessing the filesystem.
      parseRuntimeBoundaryArguments(['settings-matrix', value, caseRoot, manifestSha256]);
    }
    if (path.basename(powershellExecutable).toLowerCase() !== 'pwsh.exe') throw fail();
    const inside = (parent, child) => {
      const relative = path.relative(parent, child);
      return (
        relative !== '' &&
        relative !== '..' &&
        !relative.startsWith('..' + path.sep) &&
        !path.isAbsolute(relative)
      );
    };
    if (
      !inside(ownedRoot, install) ||
      !inside(ownedRoot, caseRoot) ||
      inside(install, caseRoot) ||
      inside(caseRoot, install) ||
      path.resolve(install).toLowerCase() === path.resolve(caseRoot).toLowerCase()
    )
      throw fail();
    return { ...request, ownedRoot, powershellExecutable };
  } catch {
    throw fail();
  }
}

function verifyInstalledHttpIdentity(request, runtime = process) {
  try {
    if (
      runtime.platform !== 'win32' ||
      runtime.execArgv.length !== 0 ||
      Object.entries(runtime.env).some(
        ([name, value]) =>
          value && ['NODE_OPTIONS', 'NODE_PATH', 'NODE_V8_COVERAGE'].includes(name.toUpperCase())
      )
    )
      throw fail();
    const installed = verifyRuntimeBoundaryInstallation(
      {
        caseId: request.caseId,
        install: request.install,
        caseRoot: request.caseRoot,
        manifestSha256: request.manifestSha256,
      },
      request.ownedRoot
    );
    safePath(request.powershellExecutable);
    if (
      fs.realpathSync.native(runtime.execPath).toLowerCase() !==
        fs.realpathSync.native(installed.node).toLowerCase() ||
      path.resolve(runtime.cwd()).toLowerCase() !== path.resolve(request.install).toLowerCase()
    )
      throw fail();
    return true;
  } catch {
    throw fail();
  }
}

function installedHttpReceipt(input, manifestSha256) {
  try {
    const report = dataSnapshot(input, 'installed_daemon_http_failed');
    const keys =
      'cases,clientQualified,gracefulDrainQualified,mode,modelRequests,passed,requiresReviewedOwnedAdapter,retentionQualified,schemaVersion,scope';
    if (
      Object.keys(report).sort().join(',') !== keys ||
      report.schemaVersion !== 1 ||
      report.scope !== 'daemon-management-http-settings' ||
      report.mode !== 'execute' ||
      report.passed !== true ||
      report.requiresReviewedOwnedAdapter !== true ||
      report.modelRequests !== 0 ||
      report.retentionQualified !== false ||
      report.clientQualified !== false ||
      report.gracefulDrainQualified !== false ||
      !/^[a-f0-9]{64}$/.test(manifestSha256) ||
      !Array.isArray(report.cases) ||
      report.cases.length !== 4
    )
      throw fail();
    const combinations = report.cases.map((item, index) => {
      if (
        Object.keys(item).sort().join(',') !==
          'applicationObserved,cleanupSemantics,configSaved,failure,label,ownedStopAcknowledged,passed,storageVerified' ||
        item.label !== LABELS[index] ||
        item.configSaved !== true ||
        item.applicationObserved !== true ||
        item.storageVerified !== true ||
        item.ownedStopAcknowledged !== true ||
        item.cleanupSemantics !== 'forced_cleanup' ||
        item.passed !== true ||
        item.failure !== null
      )
        throw fail();
      return {
        combination: item.label,
        checks: [
          'config_saved',
          'application_observed',
          'storage_verified',
          'owned_stop_acknowledged',
        ],
      };
    });
    return {
      schemaVersion: 1,
      caseId: 'daemon-http-settings-matrix',
      phase: 'current_pre_rollback',
      scope: 'installed_daemon_management_http',
      manifestSha256,
      dependencyIdentity: 'lock_only',
      modelRequests: 0,
      restartRetention: false,
      clientQualified: false,
      gracefulDrainQualified: false,
      controllerClosed: true,
      cleanupSemantics: 'forced_cleanup',
      combinations,
    };
  } catch {
    throw fail();
  }
}

// Injection is a unit-test boundary only; the fixed executable entry supplies no dependencies.
async function runInstalledDaemonHttp(
  args,
  dependencies = {
    verify: verifyInstalledHttpIdentity,
    start: startDaemonOwnedController,
    adapter: createDaemonOwnedAdapter,
    matrix: runDaemonHttpSettingsMatrix,
  }
) {
  let channel, adapter, result;
  let failed = false;
  try {
    const request = parseInstalledHttpArguments(args);
    if (dependencies.verify(request) !== true) throw fail();
    channel = dependencies.start({
      install: request.install,
      ownedRoot: request.ownedRoot,
      manifestSha256: request.manifestSha256,
      powershellExecutable: request.powershellExecutable,
    });
    adapter = dependencies.adapter(
      { install: request.install, ownedRoot: request.ownedRoot },
      channel
    );
    result = installedHttpReceipt(
      await dependencies.matrix(adapter, { mode: 'execute' }),
      request.manifestSha256
    );
  } catch {
    failed = true;
  } finally {
    try {
      if (adapter ? (await adapter.close()) !== true : channel && (await channel.close()) !== true)
        failed = true;
    } catch {
      failed = true;
    }
  }
  if (failed || !result) throw fail();
  return result;
}

module.exports = {
  parseInstalledHttpArguments,
  verifyInstalledHttpIdentity,
  installedHttpReceipt,
  runInstalledDaemonHttp,
};
