'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isBuiltin } = require('node:module');
const {
  ARTIFACT_DIRECTORY,
  digest,
  regularArtifactFile,
  readEvidenceGatewayArtifact,
} = require('./lib/evidence-gateway-artifact');

const root = path.resolve(__dirname, '..');

async function prepareEvidenceGateway() {
  try {
    return readEvidenceGatewayArtifact(root);
  } catch {
    /* An absent or stale development artifact requires a fresh build. */
  }
  const { build } = await import('vite');
  const inputs = new Map();
  const capture = (relative) => {
    const sha256 = digest(regularArtifactFile(root, relative, 2 * 1024 * 1024));
    if (inputs.has(relative) && inputs.get(relative) !== sha256)
      throw new Error('evidence_gateway_build_inputs_changed');
    inputs.set(relative, sha256);
  };
  for (const relative of [
    'package.json',
    'package-lock.json',
    'scripts/prepare-evidence-gateway.js',
    'scripts/lib/evidence-gateway-artifact.js',
    'scripts/start-evidence-mcp-gateway.js',
  ])
    capture(relative);
  const result = await build({
    configFile: false,
    root,
    logLevel: 'warn',
    ssr: { noExternal: true },
    plugins: [
      {
        name: 'hpm-evidence-inputs',
        enforce: 'pre',
        load(id) {
          if (id.includes('\0')) return;
          const relative = path.relative(root, id).replaceAll('\\', '/');
          if (/^(?:lib|scripts)\/.+\.js$/.test(relative)) {
            const bytes = regularArtifactFile(root, relative, 2 * 1024 * 1024);
            const sha256 = digest(bytes);
            if (inputs.has(relative) && inputs.get(relative) !== sha256)
              throw new Error('evidence_gateway_build_inputs_changed');
            inputs.set(relative, sha256);
            return bytes.toString('utf8');
          }
        },
      },
    ],
    build: {
      ssr: path.join(root, 'scripts/lib/evidence-gateway-runtime.js'),
      target: 'node22',
      minify: false,
      write: false,
      sourcemap: 'inline',
      outDir: path.join(root, ARTIFACT_DIRECTORY),
      commonjsOptions: { include: [/node_modules/, /scripts/, /lib/] },
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: 'gateway.cjs', inlineDynamicImports: true },
      },
    },
  });
  if (Array.isArray(result) || !result.output || result.output.length !== 1)
    throw new Error('evidence_gateway_build_output_invalid');
  const chunk = result.output[0];
  if (
    chunk.type !== 'chunk' ||
    chunk.dynamicImports.length ||
    chunk.imports.some((name) => !isBuiltin(name)) ||
    !inputs.has('scripts/lib/evidence-gateway-runtime.js')
  )
    throw new Error('evidence_gateway_build_output_invalid');
  if (!chunk.map) throw new Error('evidence_gateway_build_map_unavailable');
  for (const [file, sha256] of inputs) {
    if (digest(regularArtifactFile(root, file, 2 * 1024 * 1024)) !== sha256)
      throw new Error('evidence_gateway_build_inputs_changed');
  }
  // Inline mode already includes one complete map in the executable bytes.
  const bundle = Buffer.from(chunk.code);
  if (bundle.length < 1 || bundle.length > 8 * 1024 * 1024)
    throw new Error('evidence_gateway_build_size_exceeded');
  const bundleSha256 = digest(bundle);
  // Publish immutable content first, then atomically replace the small manifest.
  // Existing generations remain usable by already-started processes.
  for (const relative of ['runtime', ARTIFACT_DIRECTORY]) {
    const directory = path.join(root, relative);
    try {
      fs.mkdirSync(directory);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('evidence_gateway_build_output_invalid');
  }
  const directory = path.join(root, ARTIFACT_DIRECTORY);
  const file = path.join(directory, `gateway-${bundleSha256}.cjs`);
  let publicationError;
  try {
    fs.writeFileSync(file, bundle, { flag: 'wx' });
  } catch (error) {
    if (
      error.code !== 'EEXIST' ||
      digest(
        regularArtifactFile(
          root,
          `${ARTIFACT_DIRECTORY}/gateway-${bundleSha256}.cjs`,
          8 * 1024 * 1024
        )
      ) !== bundleSha256
    )
      throw error;
  }
  const manifest = {
    schemaVersion: 1,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    bundleSha256,
    inputs: [...inputs]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, sha256]) => ({ file, sha256 })),
  };
  const staged = path.join(directory, `manifest-${randomUUID()}.staged`);
  try {
    fs.writeFileSync(staged, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(staged, path.join(directory, 'manifest.json'));
  } catch (error) {
    publicationError = error;
  }
  try {
    fs.unlinkSync(staged);
  } catch (error) {
    if (error.code !== 'ENOENT' && !publicationError) publicationError = error;
  }
  if (publicationError) throw publicationError;
  return readEvidenceGatewayArtifact(root);
}

if (require.main === module) {
  Promise.resolve()
    .then(() => {
      if (process.argv.length !== 2) throw new Error('invalid_gateway_build_arguments');
      return prepareEvidenceGateway();
    })
    .catch(() => {
      process.stderr.write('evidence_gateway_build_failed\n');
      process.exitCode = 1;
    });
}

module.exports = { prepareEvidenceGateway };
