'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const { configuredAuthMode } = require('../../lib/proxy/auth-mode');
const hashFile = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fail = (code) => Object.assign(new Error('Native evidence preflight failed'), { code });
const readJson = (file) =>
  normalizeCompactionData(JSON.parse(fs.readFileSync(file, 'utf8')), 2 * 1024 * 1024);

function nativeEvidenceV2Plan(input) {
  const value = normalizeCompactionData(input, 4096);
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'arm,authorization,workloadSha256' ||
    !['control', 'compact'].includes(value.arm)
  )
    throw fail('native_v2_plan_invalid');
  const a = value.authorization;
  if (
    a?.schema !== 'hpm.context.native-evidence-v2-authorization' ||
    a.version !== 1 ||
    a.scope !== 'one_isolated_native_model_control_compact_pair' ||
    a.userExplicitlyAuthorized !== true ||
    a.additionalRequestsPerArm !== 30 ||
    a.automaticRetries !== 0 ||
    a.failedAndCompactionRequestsCounted !== true ||
    a.reusePreviouslyAuthorizedOfficialLogin !== true ||
    a.installedCodexConfigurationMayChange !== false ||
    a.productionRestartAuthorized !== false ||
    a.providerCredentialCreationAuthorized !== false ||
    a.publicationAuthorized !== false ||
    a.priorCumulativeRequests?.control !== 32 ||
    a.priorCumulativeRequests?.compact !== 40 ||
    a.newCumulativeLimits?.control !== 62 ||
    a.newCumulativeLimits?.compact !== 70 ||
    a.priorAudit !== 'context-native-evidence-candidate-20261012-pair1-audit-result.json' ||
    a.priorAuditSha256 !== '6a5fbae255e29427f83fbe8a6de0a43f16d8953c21998fd38b665a96fe4ca385' ||
    a.candidateWorkloadSha256 !== value.workloadSha256 ||
    !/^[a-f0-9]{64}$/.test(value.workloadSha256)
  )
    throw fail('native_v2_authority_unconfirmed');
  return {
    arm: value.arm,
    requestLimit: 30,
    priorRequests: a.priorCumulativeRequests[value.arm],
    cumulativeLimit: a.newCumulativeLimits[value.arm],
    resultName: 'context-native-evidence-v2-20261012-pair1-' + value.arm + '-result.json',
  };
}

function approvedNativeEvidenceRoute(input) {
  const value = normalizeCompactionData(input, 2 * 1024 * 1024);
  const profile = Array.isArray(value?.profiles)
    ? value.profiles.filter((p) => p?.id === 'openai-official')
    : [];
  const routes = Array.isArray(value?.modelRoutes)
    ? value.modelRoutes.filter((r) => r?.from === 'gpt-5.6-sol')
    : [];
  if (
    profile.length !== 1 ||
    routes.length !== 1 ||
    configuredAuthMode(profile[0]) !== 'official-login' ||
    profile[0].apiKey ||
    routes[0].profileId !== 'openai-official' ||
    typeof routes[0].to !== 'string'
  )
    throw fail('native_v2_approved_route_unavailable');
  // Only non-secret route fields are copied. The isolated proxy reuses the
  // existing official-login capability, never a copied provider key/token.
  return {
    profile: {
      id: 'openai-official',
      name: 'Authorized existing official login',
      protocol: profile[0].protocol,
      api: profile[0].api,
      targetUrl: profile[0].targetUrl,
      authMode: 'official-login',
      apiKey: '',
    },
    route: { from: 'gpt-5.6-sol', to: routes[0].to, profileId: 'openai-official' },
  };
}

function verifyNativeEvidenceV2Preflight(root, arm, workloadSha256) {
  const runtime = path.join(root, '.hpm-runtime');
  const authorizationPath = path.join(
    runtime,
    'context-native-evidence-v2-20261012-pair1-authorization.json'
  );
  const authorization = readJson(authorizationPath);
  const plan = nativeEvidenceV2Plan({ arm, authorization, workloadSha256 });
  const reportPath = path.join(runtime, plan.resultName);
  if (
    fs.existsSync(reportPath) ||
    fs.existsSync(reportPath.replace('-result.json', '-attempt.json'))
  )
    throw fail('native_v2_prior_run_must_be_preserved');
  const auditPath = path.join(runtime, authorization.priorAudit);
  if (hashFile(auditPath) !== authorization.priorAuditSha256)
    throw fail('native_v2_prior_audit_changed');
  const audit = readJson(auditPath);
  const reports = [...audit.historicalRuns, ...audit.candidateRuns];
  if (reports.length !== 15) throw fail('native_v2_prior_reports_unconfirmed');
  const totals = { control: 0, compact: 0 };
  for (const row of reports) {
    if (typeof row.report !== 'string' || !/^[a-z0-9-]+\.json$/.test(row.report))
      throw fail('native_v2_prior_reports_unconfirmed');
    const file = path.join(runtime, row.report);
    if (hashFile(file) !== row.sha256) throw fail('native_v2_prior_report_changed');
    const prior = readJson(file);
    if (!Object.hasOwn(totals, prior.benchmarkArm) || !Array.isArray(prior.transport))
      throw fail('native_v2_prior_reports_unconfirmed');
    totals[prior.benchmarkArm] += prior.transport.length;
  }
  if (totals.control !== 32 || totals.compact !== 40)
    throw fail('native_v2_prior_budget_unconfirmed');
  const protectedFiles = audit.protection.protectedFiles;
  if (
    !Array.isArray(protectedFiles) ||
    protectedFiles.length !== 11 ||
    protectedFiles.some((row) => hashFile(row.path) !== row.sha256)
  )
    throw fail('native_v2_protected_state_changed');
  const harnesses = [audit.executedHarness, ...audit.historicalHarnesses];
  if (harnesses.some((row) => hashFile(path.join(runtime, row.report)) !== row.sha256))
    throw fail('native_v2_prior_harness_changed');
  let controlSha256 = null;
  if (arm === 'compact') {
    const controlPath = path.join(
      runtime,
      'context-native-evidence-v2-20261012-pair1-control-result.json'
    );
    const control = readJson(controlPath);
    if (
      control.schema !== 'hpm.context.native-evidence-v2-candidate' ||
      control.benchmarkArm !== 'control' ||
      control.fixedWorkload?.corpusSha256 !== workloadSha256 ||
      control.phase !== 'terminal' ||
      control.nativeProcessTerminal !== true ||
      control.isolatedProxyTerminal !== true ||
      control.guardedFilesUnchanged !== true ||
      control.unsafeToolRequests !== 0 ||
      !Array.isArray(control.transport) ||
      control.transport.length > 30
    )
      throw fail('native_v2_control_unconfirmed');
    controlSha256 = hashFile(controlPath);
  }
  return {
    ...plan,
    reportPath,
    authorizationSha256: hashFile(authorizationPath),
    protectedFiles,
    controlSha256,
    route: approvedNativeEvidenceRoute(readJson(path.join(root, 'proxy.config.json'))),
  };
}

module.exports = {
  nativeEvidenceV2Plan,
  approvedNativeEvidenceRoute,
  verifyNativeEvidenceV2Preflight,
  hashFile,
};
