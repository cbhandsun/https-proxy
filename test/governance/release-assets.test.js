'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeArtifactManifest } = require('../../scripts/collect-tauri-artifacts');
const { collectReleaseAssets, toGhAssetArgument } = require('../../scripts/list-release-assets');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-release-assets-'));
try {
  const installers = path.join(root, 'dist', 'artifacts', 'installers');
  const portable = path.join(root, 'dist', 'artifacts', 'portable');
  const sbom = path.join(root, 'dist', 'artifacts', 'sbom');
  fs.mkdirSync(installers, { recursive: true });
  fs.mkdirSync(portable, { recursive: true });
  fs.mkdirSync(sbom, { recursive: true });

  const installer = path.join(installers, 'HTTPS Proxy Manager_0.1.0_x64-setup.exe');
  const archive = path.join(portable, 'HTTPS-Proxy-Manager-Portable.zip');
  fs.writeFileSync(installer, 'installer');
  fs.writeFileSync(archive, 'portable');
  writeArtifactManifest(installers, [installer]);
  writeArtifactManifest(portable, [archive]);
  fs.writeFileSync(path.join(sbom, 'npm-sbom.cdx.json'), '{"bomFormat":"CycloneDX"}\n');
  fs.writeFileSync(path.join(sbom, 'rust-sbom.cdx.json'), '{"bomFormat":"CycloneDX"}\n');

  const assets = collectReleaseAssets(root);
  assert.deepEqual(
    assets.map((asset) => asset.assetName),
    [
      'HTTPS Proxy Manager_0.1.0_x64-setup.exe',
      'HTTPS-Proxy-Manager-installers-SHA256SUMS.json',
      'HTTPS-Proxy-Manager-installers-SHA256SUMS.txt',
      'HTTPS-Proxy-Manager-Portable.zip',
      'HTTPS-Proxy-Manager-portable-SHA256SUMS.json',
      'HTTPS-Proxy-Manager-portable-SHA256SUMS.txt',
      'HTTPS-Proxy-Manager-npm-sbom.cdx.json',
      'HTTPS-Proxy-Manager-rust-sbom.cdx.json',
    ]
  );
  assert.equal(new Set(assets.map((asset) => asset.assetName)).size, assets.length);
  assert.match(
    toGhAssetArgument(assets[1]),
    /SHA256SUMS\.json#HTTPS-Proxy-Manager-installers-SHA256SUMS\.json$/
  );
  assert.throws(() => toGhAssetArgument({}), /filePath and assetName/);

  fs.rmSync(archive);
  assert.throws(
    () => collectReleaseAssets(root),
    /Portable artifact validation failed|manifest is missing/
  );
  fs.writeFileSync(archive, 'portable');
  writeArtifactManifest(portable, [archive]);
  fs.rmSync(path.join(sbom, 'npm-sbom.cdx.json'));
  assert.throws(() => collectReleaseAssets(root), /Release SBOM is missing/);
  fs.writeFileSync(path.join(sbom, 'npm-sbom.cdx.json'), '{"bomFormat":"CycloneDX"}\n');
  fs.writeFileSync(path.join(sbom, 'unexpected.cdx.json'), '{"bomFormat":"CycloneDX"}\n');
  assert.throws(() => collectReleaseAssets(root), /Release SBOM is unsupported/);
  fs.rmSync(path.join(sbom, 'unexpected.cdx.json'));
  fs.writeFileSync(path.join(installers, 'unexpected.txt'), 'unexpected');
  assert.throws(() => collectReleaseAssets(root), /Generated release layout is invalid/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('[release-assets.test] ok');
