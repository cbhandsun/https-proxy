'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'hpm-cli.js'), 'utf8');

assert.doesNotMatch(source, /JSON\.stringify\(l\.input\)/);
assert.match(source, /Input:\s+\[redacted/);
assert.match(source, /Error:\s+.*\[redacted\]/);

console.log('[cli-log-privacy.test] ok');
