'use strict';

const { sdkModel } = require('../lib/proxy/tianxi-sdk-models');
const { probeTianxiCodexNative } = require('./lib/tianxi-codex-native-probe');
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--live' || !sdkModel(args[1]))
    throw new Error('tianxi_codex_probe_arguments_invalid');
  const report = await probeTianxiCodexNative(args[1]);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.passed) process.exitCode = 1;
}
main().catch(() => {
  process.stderr.write(
    'Tianxi Codex native probe failed; production and client configuration were not changed.\n'
  );
  process.exitCode = 1;
});
