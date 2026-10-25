'use strict';
const { createPersistentIoSummary } = require('./lib/persistent-io-summary');
async function main() {
  if (process.argv.length !== 2) throw Error();
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) throw Error();
    chunks.push(chunk);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const summary = createPersistentIoSummary();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (Buffer.byteLength(line) > 8192) throw Error();
    const event = JSON.parse(line);
    if (JSON.stringify(event) !== line) throw Error();
    summary.observe(event);
  }
  const result = summary.snapshot();
  if (!result.pairedFlushes) throw Error();
  process.stdout.write(JSON.stringify(result) + '\n');
}
main().catch(() => {
  process.stderr.write('persistent_io_summary_failed\n');
  process.exitCode = 1;
});
