'use strict';

const fail = () => new Error('invalid_client_coverage_resource_probe');

// Read the pinned, unchanged package script instead of maintaining a second
// test list. Return argv for Node/c8; never execute package text through a shell.
function clientCoverageResourceArguments(command, concurrency) {
  if (typeof command !== 'string' || command.length > 32768 || ![1, 4].includes(concurrency))
    throw fail();
  const words = command.match(/"[^"\r\n]*"|[^\s"\r\n]+/g);
  if (!words || words.join(' ') !== command) throw fail();
  const args = words.map((word) => (word.startsWith('"') ? word.slice(1, -1) : word));
  const boundary = args.indexOf('node');
  if (
    args[0] !== 'c8' ||
    args.filter((word) => word === 'node').length !== 1 ||
    args.filter((word) => word === '--test-concurrency=4').length !== 1 ||
    args.slice(boundary, boundary + 5).join(' ') !==
      'node --require ./test/helpers/physical-test-temp.cjs --test --test-concurrency=4' ||
    args.slice(boundary + 5).length === 0 ||
    args.slice(boundary + 5).some((word) => !/^test\/[a-z0-9/-]+\.test\.js$/.test(word))
  )
    throw fail();
  return args
    .slice(1)
    .map((word) => (word === '--test-concurrency=4' ? '--test-concurrency=' + concurrency : word));
}

module.exports = { clientCoverageResourceArguments };
