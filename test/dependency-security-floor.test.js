'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Inventory-only regression. These are package inventory manifests, not
// imports of their APIs or a substitute for the full npm audit CI gate.
const root = path.resolve(__dirname, '..');
const floors = [
  { name: 'brace-expansion', major: 5, minor: 0, patch: 12 },
  { name: 'source-map-js', major: 1, minor: 2, patch: 2 },
  { name: 'lint-staged', major: 17, minor: 6, patch: 0 },
];
const mcpFloor = { name: '@modelcontextprotocol/sdk', major: 1, minor: 32, patch: 1 };
const ipAddressFloor = { name: 'ip-address', major: 10, minor: 7, patch: 4 };
const zodFloor = { name: 'zod', major: 4, minor: 6, patch: 6 };

function admittedVersion(value, floor) {
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  )
    return false;
  const [major, minor, patch] = value.split('.').map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger) || major !== floor.major) return false;
  return minor > floor.minor || (minor === floor.minor && patch >= floor.patch);
}

test('compatibility patch floors reject vulnerable, empty, malformed, extreme and unreviewed-major versions', () => {
  for (const floor of [...floors, mcpFloor, ipAddressFloor, zodFloor]) {
    assert.ok(admittedVersion(`${floor.major}.${floor.minor}.${floor.patch}`, floor));
    assert.ok(admittedVersion(`${floor.major}.${floor.minor}.${floor.patch + 1}`, floor));
    assert.equal(admittedVersion(`${floor.major}.${floor.minor}.${floor.patch - 1}`, floor), false);
    assert.equal(admittedVersion(`${floor.major + 1}.0.0`, floor), false);
    for (const value of [
      undefined,
      null,
      false,
      5,
      [],
      {},
      '',
      'latest',
      '5.0.12-beta',
      '05.0.12',
      '5.00.12',
      '5.0.012',
      '5.0.12\n',
      '5.0.12-secret',
      '9'.repeat(65),
      '99999999999999999999.0.0',
    ])
      assert.equal(admittedVersion(value, floor), false);
  }
  let accessed = false;
  assert.equal(
    admittedVersion(
      {
        get version() {
          accessed = true;
          return '5.0.12';
        },
      },
      floors[0]
    ),
    false
  );
  assert.equal(accessed, false);
});

test('installed and locked dependency batches both meet the security floors', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  for (const floor of floors) {
    const entry = `node_modules/${floor.name}`;
    const installed = JSON.parse(fs.readFileSync(path.join(root, entry, 'package.json'), 'utf8'));
    const locked = lock.packages?.[entry];
    assert.ok(
      admittedVersion(installed.version, floor),
      `${floor.name}: installed version requires a reviewed secure patch`
    );
    assert.ok(
      admittedVersion(locked?.version, floor),
      `${floor.name}: lockfile version requires a reviewed secure patch`
    );
    assert.ok(
      installed.version === locked.version,
      `${floor.name}: installed and locked versions differ`
    );
    assert.equal(locked.dev, true, `${floor.name}: patch batch must remain development-only`);
  }
});

test('root and staged plugin enforce the reviewed direct MCP SDK floor independently', () => {
  for (const directory of [root, path.join(root, 'plugins/hpm-local-evidence')]) {
    const read = (file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    const pkg = read('package.json');
    const lock = read('package-lock.json');
    const entry = `node_modules/${mcpFloor.name}`;
    const installed = read(`${entry}/package.json`);
    const locked = lock.packages?.[entry];
    const declared = pkg.dependencies?.[mcpFloor.name];
    assert.equal(typeof declared, 'string', 'MCP SDK must remain a direct runtime dependency');
    assert.ok(admittedVersion(declared.replace(/^\^/, ''), mcpFloor));
    assert.ok(admittedVersion(installed.version, mcpFloor));
    assert.ok(admittedVersion(locked?.version, mcpFloor));
    assert.equal(installed.version, locked.version);
    assert.equal(lock.packages?.['']?.dependencies?.[mcpFloor.name], declared);
    assert.notEqual(locked.dev, true, 'MCP SDK must remain available in production installs');
  }
});

test('root and plugin keep the IPv6 parser at a secure production patch', () => {
  // GHSA-rxp7-6hxx-x8q5: <=10.7.3 parses long zone identifiers quadratically.
  for (const directory of [root, path.join(root, 'plugins/hpm-local-evidence')]) {
    const read = (file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    const lock = read('package-lock.json');
    const entry = `node_modules/${ipAddressFloor.name}`;
    const installed = read(`${entry}/package.json`);
    const locked = lock.packages?.[entry];
    assert.ok(admittedVersion(installed.version, ipAddressFloor));
    assert.ok(admittedVersion(locked?.version, ipAddressFloor));
    assert.equal(installed.version, locked.version);
    assert.notEqual(locked.dev, true, 'IPv6 parser must remain available to production callers');
  }
});

test('root and plugin keep schema validation at a secure production patch', () => {
  // GHSA-mrhx-c7xc-m3w5: constrained oversized collections can exhaust memory.
  for (const directory of [root, path.join(root, 'plugins/hpm-local-evidence')]) {
    const read = (file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    const lock = read('package-lock.json');
    const entry = `node_modules/${zodFloor.name}`;
    const installed = read(`${entry}/package.json`);
    const locked = lock.packages?.[entry];
    assert.ok(admittedVersion(installed.version, zodFloor));
    assert.ok(admittedVersion(locked?.version, zodFloor));
    assert.equal(installed.version, locked.version);
    assert.notEqual(locked.dev, true, 'Schema validation must remain available in production');
  }
});

test('real hook integration cannot disappear from unified verification or CI', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['test:hooks'], 'node test/lint-staged-security.test.js');
  for (const entry of ['test', 'verify']) {
    assert.ok(packageJson.scripts[entry].split(' && ').includes('npm run test:hooks'));
  }
  assert.ok(packageJson.scripts['test:all'].split(' && ').includes('npm test'));
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/verify.yml'), 'utf8');
  assert.match(workflow, /^\s+- run: npm run test:hooks\s*$/m);
  assert.ok(fs.existsSync(path.join(root, 'test/lint-staged-security.test.js')));
});
