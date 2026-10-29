'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  readGeneratedPluginModules,
  retireGeneratedPluginModules,
} = require('./lib/local-evidence-plugin-stale');

// Generated package closure only; never removes shared release or user files.
function buildLocalEvidencePlugin(root = path.resolve(__dirname, '..')) {
  const plugin = path.join(root, 'plugins/hpm-local-evidence');
  const runtime = path.join(plugin, 'runtime');
  const previous = readGeneratedPluginModules(plugin);
  const visited = new Set();
  const files = [];
  function copyModule(relative) {
    const source = path.resolve(root, relative);
    const local = path.relative(root, source).replace(/\\/g, '/');
    if (
      !local.startsWith('lib/') ||
      local.includes('..') ||
      !source.endsWith('.js') ||
      fs.lstatSync(source).isSymbolicLink()
    )
      throw new Error('Plugin source boundary refused');
    if (visited.has(local)) return;
    visited.add(local);
    const content = fs.readFileSync(source);
    const text = content.toString('utf8');
    for (const match of text.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      const dependency = match[1];
      if (dependency.startsWith('.'))
        copyModule(
          path.relative(root, require.resolve(path.resolve(path.dirname(source), dependency)))
        );
      else if (
        !dependency.startsWith('node:') &&
        !dependency.startsWith('@modelcontextprotocol/sdk/')
      )
        throw new Error('Plugin undeclared dependency refused');
    }
    const target = path.join(runtime, local);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    files.push({ path: local, sha256: createHash('sha256').update(content).digest('hex') });
  }
  copyModule('lib/client/context-evidence-mcp.js');
  retireGeneratedPluginModules(runtime, previous, visited);
  fs.writeFileSync(
    path.join(plugin, 'runtime-manifest.json'),
    JSON.stringify(
      {
        schema: 'hpm.context.plugin-closure',
        version: 1,
        files: files.sort((a, b) => a.path.localeCompare(b.path)),
      },
      null,
      2
    ).replace(/\n/g, '\r\n') + '\r\n'
  );
  return { moduleCount: files.length };
}

if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(buildLocalEvidencePlugin()) + '\n');
  } catch {
    process.stderr.write('local_evidence_package_failed\n');
    process.exitCode = 1;
  }
}
module.exports = { buildLocalEvidencePlugin };
