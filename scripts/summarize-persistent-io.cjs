'use strict';
const { createPersistentIoSummary } = require('./lib/persistent-io-summary');
const { SUMMARY_CAUSES } = require('./lib/coverage-io-recorder-failure');
let failureCause = 'arguments';
async function main() {
  if (process.argv.length !== 2) throw Error();
  const chunks = [];
  let bytes = 0;
  failureCause = 'input-bytes';
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) throw Error();
    chunks.push(chunk);
  }
  failureCause = 'input-encoding';
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const summary = createPersistentIoSummary();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    failureCause = 'record-bytes';
    if (Buffer.byteLength(line) > 8192) throw Error();
    failureCause = 'record-json';
    const event = JSON.parse(line);
    failureCause = 'record-canonical';
    if (JSON.stringify(event) !== line) throw Error();
    failureCause = 'record-observe';
    summary.observe(event);
  }
  failureCause = 'snapshot';
  const result = summary.snapshot();
  failureCause = 'no-flush';
  if (!result.pairedFlushes) throw Error();
  failureCause = 'collisions';
  if (result.collisions !== 0) throw Error();
  failureCause = 'output';
  process.stdout.write(JSON.stringify(result) + '\n');
}
main().catch(() => {
  process.stderr.write(
    'persistent_io_summary_failed\npersistent_io_summary_cause=' +
      (SUMMARY_CAUSES.includes(failureCause) ? failureCause : 'output') +
      '\n'
  );
  process.exitCode = 1;
});
