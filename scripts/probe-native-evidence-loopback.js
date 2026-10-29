'use strict';

const os = require('node:os');
const path = require('node:path');
const { runNativeEvidenceLoopback } = require('./lib/native-evidence-loopback');

async function main() {
  const [mode, extra] = process.argv.slice(2);
  if (extra !== undefined) throw new Error('Invalid isolated native fixture');
  const executable = path.join(os.homedir(), 'AppData/Local/Programs/OpenAI/Codex/bin/codex.exe');
  const report = await runNativeEvidenceLoopback({ mode, executable });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.passed) process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write('Isolated native fixture failed.\n');
  process.exitCode = 1;
});
