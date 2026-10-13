'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const { approvedNativeEvidenceRoute, hashFile } = require('./native-evidence-v2-preflight');
const {
  createNativeEvidenceBenchmarkWorkloadV2,
} = require('./native-evidence-benchmark-workload-v2');

const NAME = 'context-native-evidence-diagnostic-20261012-run1';
const PRIOR_DIAGNOSTIC = 'adfbbac8ee092709dacad8ff32fb209416d5ba6823a0b5be083268cbca121c92';
const PRIOR_RUN2 = 'c0a1510c9a38df46a3c65f7278087e30b6ab9f0a5a24b59ed8991addeecb2b4a';
const PRIOR = [
  [
    'context-native-evidence-v2-20261012-pair1-control-result.json',
    '43163a97217dad50c71979116323f385d798276ed778c2113368628500eee8d1',
  ],
  [
    'context-native-evidence-v2-20261012-pair1-compact-result.json',
    '40cd4511da38ded40349a1de643b48494d1420686f7b7751a5a1a2f74a5c5cd1',
  ],
  [
    'context-native-evidence-candidate-20261012-pair1-audit-result.json',
    '6a5fbae255e29427f83fbe8a6de0a43f16d8953c21998fd38b665a96fe4ca385',
  ],
];
const fail = (code) => Object.assign(new Error('Native diagnostic preflight failed'), { code });
const read = (file) =>
  normalizeCompactionData(JSON.parse(fs.readFileSync(file, 'utf8')), 2 * 1024 * 1024);

function validateNativeEvidenceDiagnosticAuthority(input) {
  const authorization = normalizeCompactionData(input, 4096);
  if (
    authorization?.schema !== 'hpm.context.native-evidence-diagnostic-authorization' ||
    authorization.version !== 1 ||
    authorization.scope !== 'one_isolated_native_retained_read_diagnostic' ||
    authorization.userExplicitlyAuthorized !== true ||
    authorization.maximumAdditionalRequests !== 6 ||
    authorization.automaticRetries !== 0 ||
    authorization.failedAndCompactionRequestsCounted !== true ||
    authorization.reusePreviouslyAuthorizedOfficialLogin !== true ||
    authorization.installedCodexConfigurationMayChange !== false ||
    authorization.productionRestartAuthorized !== false ||
    authorization.providerCredentialCreationAuthorized !== false ||
    authorization.publicationAuthorized !== false
  )
    throw fail('native_diagnostic_authority_unconfirmed');
  return authorization;
}

function verifyNativeEvidenceDiagnosticPlan(root, run = 'run1') {
  if (!['run1', 'run2', 'run3'].includes(run)) throw fail('native_diagnostic_run_invalid');
  const directory = path.join(root, '.hpm-runtime');
  const name = run === 'run1' ? NAME : 'context-native-evidence-diagnostic-20261012-' + run;
  const authorizationPath = path.join(directory, name + '-authorization.json');
  const authorization = validateNativeEvidenceDiagnosticAuthority(read(authorizationPath));
  if (
    run === 'run2' &&
    (authorization.diagnosticRun !== 'run2' ||
      authorization.priorDiagnosticSha256 !== PRIOR_DIAGNOSTIC)
  )
    throw fail('native_diagnostic_authority_unconfirmed');
  if (
    run === 'run3' &&
    (authorization.diagnosticRun !== 'run3' ||
      authorization.priorDiagnosticSha256 !== PRIOR_RUN2 ||
      authorization.productNativeGuidanceCandidate !== true)
  )
    throw fail('native_diagnostic_authority_unconfirmed');
  const reportPath = path.join(directory, name + '-result.json');
  const attemptPath = path.join(directory, name + '-attempt.json');
  if (fs.existsSync(reportPath) || fs.existsSync(attemptPath))
    throw fail('native_diagnostic_prior_run_must_be_preserved');
  for (const [file, sha] of PRIOR) {
    if (hashFile(path.join(directory, file)) !== sha)
      throw fail('native_diagnostic_prior_evidence_changed');
  }
  const control = read(path.join(directory, PRIOR[0][0]));
  const compact = read(path.join(directory, PRIOR[1][0]));
  if (
    control.transport?.length !== 2 ||
    compact.transport?.length !== 12 ||
    control.requestBudget?.cumulativeRequests !== 34 ||
    compact.requestBudget?.cumulativeRequests !== 52
  )
    throw fail('native_diagnostic_prior_budget_unconfirmed');
  const priorAudit = read(path.join(directory, PRIOR[2][0]));
  if (run !== 'run1') {
    const priorPath = path.join(directory, NAME + '-result.json');
    if (hashFile(priorPath) !== PRIOR_DIAGNOSTIC)
      throw fail('native_diagnostic_prior_evidence_changed');
    const prior = read(priorPath);
    if (
      prior.phase !== 'terminal' ||
      prior.transport?.length !== 1 ||
      prior.requestBudget?.cumulativeRequests !== 87 ||
      prior.nativeProcessTerminal !== true ||
      prior.isolatedProxyTerminal !== true ||
      prior.loopbackServerTerminal !== true ||
      prior.guardedFilesUnchanged !== true ||
      prior.isolatedDirectoriesRemoved !== true
    )
      throw fail('native_diagnostic_prior_budget_unconfirmed');
  }
  if (run === 'run3') {
    const priorPath = path.join(
      directory,
      'context-native-evidence-diagnostic-20261012-run2-result.json'
    );
    if (hashFile(priorPath) !== PRIOR_RUN2) throw fail('native_diagnostic_prior_evidence_changed');
    const prior = read(priorPath);
    if (
      prior.phase !== 'terminal' ||
      prior.transport?.length !== 1 ||
      prior.requestBudget?.cumulativeRequests !== 88 ||
      prior.nativeProcessTerminal !== true ||
      prior.isolatedProxyTerminal !== true ||
      prior.loopbackServerTerminal !== true ||
      prior.guardedFilesUnchanged !== true ||
      prior.isolatedDirectoriesRemoved !== true
    )
      throw fail('native_diagnostic_prior_budget_unconfirmed');
  }
  const protectedFiles = priorAudit.protection?.protectedFiles;
  if (
    !Array.isArray(protectedFiles) ||
    protectedFiles.length !== 11 ||
    protectedFiles.some((row) => hashFile(row.path) !== row.sha256)
  )
    throw fail('native_diagnostic_protected_state_changed');
  return {
    reportPath,
    attemptPath,
    protectedFiles,
    requestLimit: 6,
    priorRequests: run === 'run3' ? 88 : run === 'run2' ? 87 : 86,
    cumulativeLimit: run === 'run3' ? 94 : run === 'run2' ? 93 : 92,
    authorizationSha256: hashFile(authorizationPath),
    route: approvedNativeEvidenceRoute(read(path.join(root, 'proxy.config.json'))),
  };
}

function createNativeEvidenceDiagnosticWorkload() {
  const workload = createNativeEvidenceBenchmarkWorkloadV2();
  try {
    for (const document of ['design', 'verification', 'release']) {
      if (!workload.reply('hpm_read_branch', { document }).ok)
        throw fail('native_diagnostic_seed_failed');
    }
    let offsetBytes = 0;
    do {
      const reply = workload.reply('hpm_read_page', { offsetBytes });
      if (!reply.ok) throw fail('native_diagnostic_seed_failed');
      offsetBytes = JSON.parse(reply.text).page.nextOffsetBytes;
    } while (offsetBytes !== null);
    return {
      ...workload,
      prompts: [
        '这是隔离的只读接口诊断，不是完整任务或压缩质量验收。七份合成证据已由测试夹具预存。' +
          '仅调用 hpm_list_retained_evidence 列表工具一次并完整输出结果，' +
          '随后使用其中首个条目的 sourceId 和 digest，调用 hpm_read_retained_evidence 一次，' +
          'offsetBytes=0、limitBytes=8192，完整输出单页结果。不要调用原始读取工具或校验工具，' +
          '不要执行命令、文件操作、网络请求、其他工具或子代理。Code Mode 使用 text(result)，' +
          '不要使用 console.log，每次 exec 只输出一个完整结果；工具失败立即停止，不修正或重试。' +
          '结束时只回复“诊断结束”，不作验收通过或状态正确的断言。',
      ],
    };
  } catch (problem) {
    workload.close();
    throw problem;
  }
}

module.exports = {
  validateNativeEvidenceDiagnosticAuthority,
  verifyNativeEvidenceDiagnosticPlan,
  createNativeEvidenceDiagnosticWorkload,
};
