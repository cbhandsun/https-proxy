'use strict';

const path = require('node:path');
const { verifyNativeEvidenceDiagnosticPlan } = require('./lib/native-evidence-diagnostic-plan');
const { runNativeEvidenceDiagnostic } = require('./lib/native-evidence-diagnostic-runtime');
const root = path.resolve(__dirname, '..');
const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 1 ||
    ![
      '--preflight',
      '--live',
      '--preflight-run2',
      '--live-run2',
      '--preflight-run3',
      '--live-run3',
    ].includes(args[0])
  )
    throw new TypeError('Explicit diagnostic mode required');
  const run = args[0].endsWith('-run3') ? 'run3' : args[0].endsWith('-run2') ? 'run2' : 'run1';
  if (args[0].startsWith('--preflight')) {
    const plan = verifyNativeEvidenceDiagnosticPlan(root, run);
    write({
      preflightPassed: true,
      maximumRequests: plan.requestLimit,
      protectedFileCount: plan.protectedFiles.length,
      realProviderRequests: 0,
    });
  } else {
    const report = await runNativeEvidenceDiagnostic(root, write, run);
    if (!report.diagnosticCompleted) process.exitCode = 1;
  }
}
main().catch((problem) => {
  write({
    failed: true,
    code:
      typeof problem?.code === 'string' && /^native_[a-z0-9_]{1,80}$/.test(problem.code)
        ? problem.code
        : 'native_diagnostic_cli_failed',
  });
  process.exitCode = 1;
});
