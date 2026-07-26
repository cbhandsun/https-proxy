// Static safety checks for the frontend CLI module dynamic list rendering.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'tauri-ui', 'src', 'app', 'domains', 'cli.js'),
  'utf8'
);

assert.ok(
  !/item\.innerHTML\s*=/.test(source),
  'CLI profile list should build item rows with DOM APIs'
);
assert.ok(!/\.innerHTML\s*=/.test(source), 'CLI module should not assign innerHTML');
assert.ok(
  !/rows\.map\(row\s*=>\s*row\.html\)/.test(source),
  'CLI session rows should not be rendered from HTML strings'
);
assert.ok(
  !/data-token="\$\{/.test(source),
  'CLI session token should not be interpolated into HTML attributes'
);
assert.ok(
  source.includes('deleteButton.dataset.token = row.token'),
  'CLI delete token should be assigned through dataset'
);
assert.ok(
  source.includes('toolName.textContent = row.toolName'),
  'CLI tool name should render through textContent'
);
assert.ok(
  source.includes('function createCliLaunchIcon()'),
  'CLI launch icon should render through SVG DOM helper'
);
assert.ok(
  source.includes('setCliLaunchButtonReady()'),
  'CLI launch button should reset through DOM helper'
);
assert.ok(
  source.includes('cliDependencies.storage.parseCliProfiles('),
  'CLI profiles should pass through the shared localStorage boundary parser'
);
assert.ok(
  source.includes('cliDependencies.storage.normalizeCliProfiles(profiles)'),
  'CLI profiles should be normalized again before persistence'
);

console.log('app-cli.test.js ok');
