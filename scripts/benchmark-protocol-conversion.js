'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {
  parseArguments,
  integer,
  measureCase,
  runBenchmark,
} = require('./lib/protocol-benchmark-runner');
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--worker') {
    if (args.length !== 5) throw new TypeError('Invalid worker arguments');
    process.stdout.write(
      JSON.stringify(
        measureCase(args[1], args[2], integer(args[3], 1, 10000), integer(args[4], 0, 200))
      )
    );
  } else {
    const options = parseArguments(args);
    const report = runBenchmark(options, __filename);
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    const prettier = require('prettier');
    const formatOptions = await prettier.resolveConfig(options.output);
    const formatted = await prettier.format(JSON.stringify(report), {
      ...formatOptions,
      filepath: options.output,
    });
    fs.writeFileSync(options.output, formatted, 'utf8');
    process.stdout.write(
      JSON.stringify({
        cases: report.summary.length,
        samples: report.samples.length,
        parityVerified: report.samples.every((sample) => sample.parityVerified),
      }) + '\n'
    );
  }
}
main().catch(() => {
  process.stderr.write(
    'Protocol conversion benchmark failed; check arguments and fixture parity.\n'
  );
  process.exitCode = 1;
});
