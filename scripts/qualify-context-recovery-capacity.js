'use strict';

const { runCapacityProfiles } = require('./lib/context-recovery-capacity-parallel');
const { performance } = require('node:perf_hooks');
const { createCapacityQualificationReport } = require('./lib/context-recovery-capacity-timing');

async function main() {
  if (process.argv.length !== 2) throw new Error();
  const started = performance.now();
  const profiles = await runCapacityProfiles();
  const report = createCapacityQualificationReport(profiles, performance.now() - started);
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exitCode = report.qualified ? 0 : 1;
}
main().catch(() => {
  process.stderr.write('context_recovery_capacity_qualification_failed\n');
  process.exitCode = 2;
});
