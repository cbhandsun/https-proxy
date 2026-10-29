'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isBuiltin } = require('node:module');
const { buildLocalEvidencePlugin } = require('../../scripts/build-local-evidence-plugin');

const TEMPLATE_FILES = [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'hooks/hooks.json',
  'mcp.json',
  'package.json',
  'package-lock.json',
  'plugin.portable.json',
  'server.cjs',
];

function createLegacyPluginFixture(t, sourceRoot) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-plugin-clean-fixture-'));
  t.after(() => {
    if (
      path.dirname(directory) !== path.resolve(os.tmpdir()) ||
      !path.basename(directory).startsWith('hpm-plugin-clean-fixture-')
    )
      throw new Error('plugin_fixture_cleanup_refused');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const plugin = path.join(directory, 'plugins/hpm-local-evidence');
  const sourcePlugin = path.join(sourceRoot, 'plugins/hpm-local-evidence');
  const write = (relative, bytes) => {
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' });
  };
  for (const name of TEMPLATE_FILES) {
    const source = path.join(sourcePlugin, name);
    if (!fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink())
      throw new Error('plugin_fixture_template_refused');
    write('plugins/hpm-local-evidence/' + name, fs.readFileSync(source));
  }
  const visited = new Set();
  const sdk = new Map();
  function copyModule(source) {
    const relative = path.relative(sourceRoot, source).replaceAll('\\', '/');
    if (
      !relative.startsWith('lib/') ||
      relative.split('/').includes('..') ||
      !relative.endsWith('.js') ||
      fs.realpathSync(source) !== path.resolve(source) ||
      !fs.lstatSync(source).isFile()
    )
      throw new Error('plugin_fixture_source_refused');
    if (visited.has(relative)) return;
    visited.add(relative);
    const bytes = fs.readFileSync(source);
    for (const match of bytes.toString('utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      const dependency = match[1];
      if (dependency.startsWith('.'))
        copyModule(require.resolve(path.resolve(path.dirname(source), dependency)));
      else if (dependency.startsWith('@modelcontextprotocol/sdk/'))
        sdk.set(dependency, require.resolve(dependency, { paths: [sourceRoot] }));
      else if (!isBuiltin(dependency)) throw new Error('plugin_fixture_dependency_refused');
    }
    write(relative, bytes);
  }
  copyModule(path.join(sourceRoot, 'lib/client/context-evidence-mcp.js'));
  buildLocalEvidencePlugin(directory);
  const preload = path.join(directory, 'sdk-preload.cjs');
  // Test-only SDK resolutions are exact, captured before spawn, and never installed/copied.
  fs.writeFileSync(
    preload,
    "'use strict';\nconst Module = require('node:module');\n" +
      'const sdk = new Map(' +
      JSON.stringify([...sdk]) +
      ');\n' +
      'const original = Module._resolveFilename;\n' +
      'Module._resolveFilename = function(request, parent, ...args) {\n' +
      '  if (sdk.has(request)) return sdk.get(request);\n' +
      "  if (request.startsWith('@modelcontextprotocol/sdk/')) throw new Error('plugin_fixture_dependency_refused');\n" +
      '  return Reflect.apply(original, this, [request, parent, ...args]);\n};\n',
    { flag: 'wx' }
  );
  return {
    root: directory,
    plugin,
    preload,
    read: (name) => JSON.parse(fs.readFileSync(path.join(plugin, name), 'utf8')),
  };
}

module.exports = { createLegacyPluginFixture };
