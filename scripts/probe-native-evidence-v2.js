'use strict';

const path = require('node:path');
const {
  createNativeEvidenceBenchmarkWorkloadV2,
} = require('./lib/native-evidence-benchmark-workload-v2');
const { verifyNativeEvidenceV2Preflight } = require('./lib/native-evidence-v2-preflight');
const { runNativeEvidenceV2 } = require('./lib/native-evidence-v2-runtime');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
async function main() {
  if (
    args.length !== 2 ||
    !['--preflight', '--live'].includes(args[0]) ||
    !['control', 'compact'].includes(args[1])
  )
    throw new TypeError('Explicit mode and arm required');
  if (args[0] === '--preflight') {
    const workload = createNativeEvidenceBenchmarkWorkloadV2();
    try {
      const plan = verifyNativeEvidenceV2Preflight(root, args[1], workload.descriptor.corpusSha256);
      write({
        preflightPassed: true,
        arm: plan.arm,
        requestLimit: plan.requestLimit,
        priorRequests: plan.priorRequests,
        cumulativeLimit: plan.cumulativeLimit,
        protectedFileCount: plan.protectedFiles.length,
        realProviderRequests: 0,
      });
    } finally {
      workload.close();
    }
  } else {
    const report = await runNativeEvidenceV2(root, args[1], write);
    if (!report.passed) process.exitCode = 1;
  }
}
main().catch((problem) => {
  write({
    failed: true,
    code:
      typeof problem?.code === 'string' && /^native_[a-z0-9_]{1,80}$/.test(problem.code)
        ? problem.code
        : 'native_v2_cli_failed',
  });
  process.exitCode = 1;
});
