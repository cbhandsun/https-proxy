'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isBuiltin } = require('node:module');
const { readBundledFile, PACKAGE_FILES, sha } = require('./local-evidence-plugin-bundle');
const { inspectLocalEvidencePlugin } = require('./local-evidence-plugin-vault');

function cleanupStaging(staging, parent) {
  if (!staging) return;
  if (
    path.dirname(path.resolve(staging)) !== path.resolve(parent) ||
    !path.basename(staging).startsWith('.staging-') ||
    fs.lstatSync(staging).isSymbolicLink() ||
    path.resolve(fs.realpathSync(parent)).toLowerCase() !== path.resolve(parent).toLowerCase()
  )
    throw new Error('local_evidence_bundle_output_refused');
  fs.rmSync(staging, { recursive: true });
}

async function prepareLocalEvidencePlugin(root = path.resolve(__dirname, '../..')) {
  if (typeof root !== 'string' || !path.isAbsolute(root))
    throw new Error('local_evidence_bundle_refused');
  const plugin = path.join(root, 'plugins/hpm-local-evidence');
  const inputs = new Map();
  const capture = (relative) => {
    const bytes = readBundledFile(root, relative);
    const hash = sha(bytes);
    if (inputs.has(relative) && inputs.get(relative) !== hash)
      throw new Error('local_evidence_bundle_inputs_changed');
    inputs.set(relative, hash);
    return bytes;
  };
  const prefix = 'plugins/hpm-local-evidence/';
  const files = new Map();
  for (const name of PACKAGE_FILES) {
    if (name === 'server.cjs' || name === 'third-party-notices.json') continue;
    files.set(name, capture(prefix + name));
  }
  for (const name of [
    'scripts/prepare-local-evidence-plugin.js',
    'scripts/lib/local-evidence-plugin-build.js',
    'scripts/lib/local-evidence-plugin-bundle.js',
    'package.json',
    'package-lock.json',
  ])
    capture(name);
  const { build } = await import('vite');
  const result = await build({
    configFile: false,
    root,
    logLevel: 'warn',
    ssr: { noExternal: true },
    plugins: [
      {
        name: 'hpm-plugin-inputs',
        enforce: 'pre',
        resolveId(source) {
          if (source.startsWith('@modelcontextprotocol/sdk/'))
            return require.resolve(source, { paths: [plugin] });
        },
        load(id) {
          if (id.includes('\0') || id.endsWith('?commonjs-entry') || !path.isAbsolute(id)) return;
          const relative = path.relative(root, id).replaceAll('\\', '/');
          if (
            !relative.startsWith(prefix) &&
            !relative.startsWith('lib/') &&
            relative !== 'scripts/lib/local-evidence-plugin-entry.js'
          )
            throw new Error('local_evidence_bundle_import_boundary');
          return capture(relative).toString('utf8');
        },
      },
    ],
    build: {
      ssr: path.join(root, 'scripts/lib/local-evidence-plugin-entry.js'),
      target: 'node22',
      minify: false,
      write: false,
      sourcemap: false,
      commonjsOptions: { include: [/node_modules/, /lib/] },
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: 'server.cjs', inlineDynamicImports: true },
      },
    },
  });
  if (Array.isArray(result) || result.output?.length !== 1)
    throw new Error('local_evidence_bundle_output_refused');
  const chunk = result.output[0];
  if (
    chunk.type !== 'chunk' ||
    chunk.dynamicImports.length ||
    chunk.imports.some((name) => !isBuiltin(name))
  )
    throw new Error('local_evidence_bundle_output_refused');
  files.set('server.cjs', Buffer.from(chunk.code));
  const packagePaths = new Set();
  for (const file of inputs.keys()) {
    if (!file.startsWith(prefix)) continue;
    const match = file.slice(prefix.length).match(/^(node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (match) packagePaths.add(match[1]);
  }
  const lock = JSON.parse(files.get('package-lock.json'));
  const packages = [...packagePaths].sort().map((packagePath) => {
    const pkg = JSON.parse(capture(prefix + packagePath + '/package.json'));
    if (
      pkg.version !== lock.packages?.[packagePath]?.version ||
      packagePath !== 'node_modules/' + pkg.name
    )
      throw new Error('local_evidence_bundle_dependency_refused');
    const notices = fs
      .readdirSync(path.join(plugin, packagePath))
      .filter((name) => /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[.-][A-Za-z0-9_-]+)?$/i.test(name))
      .sort()
      .map((name) => capture(prefix + packagePath + '/' + name).toString('utf8'));
    return { path: packagePath, name: pkg.name, version: pkg.version, notices };
  });
  files.set(
    'third-party-notices.json',
    Buffer.from(
      JSON.stringify(
        {
          schema: 'hpm.context.plugin-sbom',
          version: 1,
          lockSha256: sha(files.get('package-lock.json')),
          packages,
        },
        null,
        2
      ) + '\n'
    )
  );
  for (const [file, hash] of inputs)
    if (sha(readBundledFile(root, file)) !== hash)
      throw new Error('local_evidence_bundle_inputs_changed');
  const manifest = Buffer.from(
    JSON.stringify(
      {
        schema: 'hpm.context.plugin-bundle',
        version: 1,
        nodeMajor: 22,
        files: [...files]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, bytes]) => ({ path: name, sha256: sha(bytes) })),
        inputs: [...inputs]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, hash]) => ({ path: name, sha256: hash })),
      },
      null,
      2
    ) + '\n'
  );
  files.set('runtime-manifest.json', manifest);
  const parent = path.join(root, 'runtime/local-evidence-plugin');
  for (const name of [path.join(root, 'runtime'), parent]) {
    fs.mkdirSync(name, { recursive: true });
    const stat = fs.lstatSync(name);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('local_evidence_bundle_output_refused');
  }
  const generation = path.join(parent, sha(manifest));
  const packageDirectory = path.join(generation, 'package');
  const marketplace = Buffer.from(
    JSON.stringify(
      {
        name: 'hpm-local',
        interface: { displayName: 'HPM Local Plugins' },
        plugins: [
          {
            name: 'hpm-local-evidence',
            source: { source: 'local', path: './package' },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Productivity',
          },
        ],
      },
      null,
      2
    ) + '\n'
  );
  let staging;
  try {
    if (!fs.existsSync(generation)) {
      staging = fs.mkdtempSync(path.join(parent, '.staging-'));
      for (const [name, bytes] of files) {
        const destination = path.join(staging, 'package', name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, bytes, { flag: 'wx' });
      }
      inspectLocalEvidencePlugin(path.join(staging, 'package'));
      fs.mkdirSync(path.join(staging, '.agents/plugins'), { recursive: true });
      fs.writeFileSync(path.join(staging, '.agents/plugins/marketplace.json'), marketplace, {
        flag: 'wx',
      });
      try {
        fs.renameSync(staging, generation);
        staging = undefined;
      } catch (error) {
        // A concurrent builder may publish identical immutable bytes first.
        // Keep our staging until the winner passes all checks below; permission
        // and other failures still propagate, and a changed winner is refused.
        const windowsExistingWinner =
          process.platform === 'win32' && error.code === 'EPERM' && fs.existsSync(generation);
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) && !windowsExistingWinner) throw error;
      }
    }
    const description = inspectLocalEvidencePlugin(packageDirectory);
    for (const [name, bytes] of files)
      if (!readBundledFile(packageDirectory, name).equals(bytes))
        throw new Error('local_evidence_bundle_output_refused');
    if (!readBundledFile(generation, '.agents/plugins/marketplace.json').equals(marketplace))
      throw new Error('local_evidence_bundle_output_refused');
    return {
      ...description,
      packageDirectory,
      marketplaceDirectory: generation,
      bundleSha256: sha(files.get('server.cjs')),
      inputCount: inputs.size,
    };
  } finally {
    cleanupStaging(staging, parent);
  }
}

module.exports = { prepareLocalEvidencePlugin };
