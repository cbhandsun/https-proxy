'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildModuleGraph,
  extractStaticImports,
  findCycles,
} = require('../../lib/governance/module-graph');
const { stripEsmSyntax } = require('./helpers/strip-esm-syntax');

const repoRoot = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const html = read('tauri-ui/index.html');
const main = read('tauri-ui/src/main.js');
const viteConfig = read('vite.config.mjs');
const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
const packageJson = JSON.parse(read('package.json'));
const frontendSourceRoot = path.join(repoRoot, 'tauri-ui', 'src');
const moduleGraph = buildModuleGraph(frontendSourceRoot);

assert.equal(
  stripEsmSyntax("import value from './value.js';\nexport function example() { return value; }"),
  'function example() { return value; }'
);

assert.match(html, /<script\s+type="module"\s+src="\/src\/main\.js"><\/script>/);
assert.doesNotMatch(html, /<script[^>]+app(?:-[^"]+)?\.js/);
assert.doesNotMatch(html, /cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com/);
assert.doesNotMatch(
  read('tauri-ui/src/app/bootstrap.js'),
  /fonts\.googleapis\.com|fonts\.gstatic\.com/
);
assert.doesNotMatch(
  JSON.stringify(tauriConfig.app.security.csp),
  /fonts\.googleapis\.com|fonts\.gstatic\.com/
);
assert.match(main, /import '\.\/styles\/app\.css';/);
assert.match(main, /import '\.\/app\/bootstrap\.js';/);
assert.doesNotMatch(main, /import '\.\/app\/ux\.js';/);
assert.match(read('tauri-ui/src/app/bootstrap.js'), /from '\.\/ux\.js';/);
assert.doesNotMatch(
  read('tauri-ui/src/app/ux.js') +
    read('tauri-ui/src/app/bootstrap.js') +
    read('tauri-ui/src/app/domains/cli.js') +
    read('tauri-ui/src/app/domains/prompts.js'),
  /window\.UX/,
  'frontend UX dependencies must use ESM imports and injection'
);
assert.match(viteConfig, /base:\s*'\.\/'/);
assert.match(viteConfig, /sourcemap:\s*false/);
assert.deepEqual(
  findCycles(moduleGraph).map((cycle) =>
    cycle.map((file) => path.relative(frontendSourceRoot, file).replaceAll('\\', '/'))
  ),
  [],
  'frontend ESM graph must stay acyclic'
);
assert.equal(fs.existsSync(path.join(repoRoot, 'tauri-ui/src/styles/app.css')), true);
assert.equal(fs.existsSync(path.join(frontendSourceRoot, 'app', 'bootstrap.js')), true);
assert.equal(fs.existsSync(path.join(frontendSourceRoot, 'app', 'ux.js')), true);
assert.equal(
  fs.existsSync(path.join(frontendSourceRoot, 'app', 'models', 'configuration.js')),
  true
);
for (const modelName of ['profile-save.js', 'proxy-command.js']) {
  const modelPath = path.join(frontendSourceRoot, 'app', 'models', modelName);
  assert.equal(fs.existsSync(modelPath), true, `${modelName} must live under app/models`);
  assert.deepEqual(
    extractStaticImports(fs.readFileSync(modelPath, 'utf8')).filter((specifier) =>
      specifier.startsWith('.')
    ),
    [],
    `${modelName} must remain dependency-free`
  );
}
assert.equal(fs.existsSync(path.join(frontendSourceRoot, 'modules')), false);
assert.ok(
  read('tauri-ui/src/app/bootstrap.js').split(/\r?\n/).length <= 4000,
  'bootstrap must stay below the current composition-layer size budget'
);
assert.deepEqual(
  extractStaticImports(read('tauri-ui/src/app/models/configuration.js')).filter((specifier) =>
    specifier.startsWith('.')
  ),
  [],
  'configuration model must remain dependency-free'
);
for (const domainName of [
  'audit.js',
  'bridge.js',
  'cli.js',
  'diagnostics.js',
  'tool-status.js',
  'environment.js',
  'mcp.js',
  'prompts.js',
  'rate-limits.js',
]) {
  const domainPath = path.join(frontendSourceRoot, 'app', 'domains', domainName);
  assert.equal(
    fs.existsSync(domainPath),
    true,
    `${domainName} must live under tauri-ui/src/app/domains`
  );
  const imports = extractStaticImports(fs.readFileSync(domainPath, 'utf8'));
  assert.equal(
    imports
      .filter((specifier) => specifier.startsWith('.'))
      .every(
        (specifier) =>
          specifier === '../runtime/dependencies.js' ||
          specifier === '../runtime/frontend-errors.js' ||
          (domainName === 'audit.js' && specifier === '../runtime/audit-format.js') ||
          (domainName === 'audit.js' && specifier === '../runtime/audit-usage-report.js') ||
          (domainName === 'bridge.js' && specifier === '../models/proxy-command.js')
      ),
    true,
    `${domainName} may import runtime boundaries but not bootstrap or other domains`
  );
}
for (const runtimeName of [
  'app-state.js',
  'dependencies.js',
  'dom.js',
  'frontend-errors.js',
  'performance.js',
]) {
  const runtimePath = path.join(frontendSourceRoot, 'app', 'runtime', runtimeName);
  assert.equal(
    fs.existsSync(runtimePath),
    true,
    `${runtimeName} must live under tauri-ui/src/app/runtime`
  );
  assert.deepEqual(
    extractStaticImports(fs.readFileSync(runtimePath, 'utf8')).filter((specifier) =>
      specifier.startsWith('.')
    ),
    [],
    `${runtimeName} must remain dependency-free`
  );
}

assert.equal(tauriConfig.build.frontendDist, '../tauri-ui/dist');
assert.match(tauriConfig.build.beforeDevCommand, /frontend:dev/);
assert.match(tauriConfig.build.beforeBuildCommand, /frontend:build/);
assert.match(tauriConfig.build.beforeBuildCommand, /npm run release:prepare/);
assert.doesNotMatch(
  JSON.stringify(tauriConfig.build),
  /sync-frontend|prepare-tauri-dist|dev-static-server/
);

assert.equal(packageJson.scripts['frontend:sync'], undefined);
assert.equal(packageJson.scripts['frontend:check'], undefined);
assert.match(packageJson.scripts.verify, /npm run format:check/);
assert.equal(packageJson.scripts.postinstall, undefined);
assert.equal(packageJson.dependencies['chart.js'] != null, true);
assert.match(packageJson.scripts['frontend:build'], /check:architecture/);
assert.match(packageJson.scripts['frontend:build'], /clean:frontend/);
assert.match(packageJson.scripts['test:frontend:coverage'], /c8/);
assert.match(packageJson.scripts['clean:frontend'], /--frontend-only/);
assert.match(packageJson.scripts['clean:coverage'], /--coverage-only/);
assert.match(packageJson.scripts['clean:test-runtime'], /--test-only/);
assert.match(packageJson.scripts['clean:staging'], /--staging-only/);
assert.match(packageJson.scripts['clean:artifacts'], /--artifacts-only/);
assert.match(packageJson.scripts['release:prepare'], /prepare-release-runtime\.js/);
assert.equal(
  fs.existsSync(path.join(repoRoot, 'dist', 'tauri-ui')),
  false,
  'obsolete dist/tauri-ui output must not return'
);

for (const removedPath of [
  'electron-ui.html',
  'app.css',
  'app-ux.js',
  'app-bridge.js',
  'app-audit.js',
  'app-cli.js',
  'app-diagnostics.js',
  'app-tool-status.js',
  'app-environment.js',
  'app-mcp.js',
  'app.js',
  'tauri-ui/electron-ui.html',
  'scripts/sync-frontend.js',
  'scripts/prepare-tauri-dist.js',
  'test/app-audit.test.js',
  'test/app-bridge.test.js',
  'test/app-cli.test.js',
  'test/app-diagnostics.test.js',
  'test/app-ux.test.js',
  'test/frontend-build-governance.test.js',
]) {
  assert.equal(
    fs.existsSync(path.join(repoRoot, removedPath)),
    false,
    `${removedPath} must stay removed`
  );
}

console.log('[frontend-build-governance.test] ok');
