'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { buildYargs } = require('c8/lib/parse-args');
const packageJson = require('../package.json');

test('proxy coverage command emits the exact fresh report consumed by the security gate', () => {
  const command = packageJson.scripts['test:coverage'];
  const reports = command.match(/--reports-dir\s+(\S+)/);
  const temporary = command.match(/--temp-directory\s+(\S+)/);
  assert.ok(reports && temporary, 'coverage locations must be explicit');
  const options = buildYargs().parse([
    '--reports-dir',
    reports[1],
    '--temp-directory',
    temporary[1],
    'node',
  ]);
  assert.equal(options['reports-dir'], 'coverage/proxy');
  assert.equal(path.dirname(options['temp-directory']), options['reports-dir']);
  assert.match(command, /&& node scripts\/check-security-coverage\.js$/);
});
