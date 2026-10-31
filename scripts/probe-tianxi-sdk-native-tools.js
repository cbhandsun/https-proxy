'use strict';

const { sdkModel } = require('../lib/proxy/tianxi-sdk-models');
const { probeTianxiSdkNativeTools } = require('./lib/tianxi-sdk-mcp-probe');

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--live' || !sdkModel(args[1]))
    throw new Error(
      'usage: node scripts/probe-tianxi-sdk-native-tools.js --live <backend-model-id>'
    );
  const report = await probeTianxiSdkNativeTools(args[1]);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.passed) process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write('Tianxi SDK native-tools probe failed; no production route was changed.\n');
  process.exitCode = 1;
});
