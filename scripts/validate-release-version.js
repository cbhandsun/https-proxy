'use strict';

const fs = require('node:fs');
const path = require('node:path');

function expectedReleaseTag(version) {
  const normalized = String(version || '').trim();
  if (!normalized) throw new TypeError('release version must be non-empty');
  return `v${normalized}`;
}

function validateReleaseVersion({ tagName, packageVersion, tauriVersion }) {
  const errors = [];
  const tag = String(tagName || '').trim();
  const npmVersion = String(packageVersion || '').trim();
  const nativeVersion = String(tauriVersion || '').trim();
  if (!tag) errors.push('GITHUB_REF_NAME must provide a release tag');
  if (!npmVersion) errors.push('package.json version must be non-empty');
  if (!nativeVersion) errors.push('src-tauri/tauri.conf.json version must be non-empty');
  if (npmVersion && nativeVersion && npmVersion !== nativeVersion) {
    errors.push(`package and Tauri versions differ: ${npmVersion} != ${nativeVersion}`);
  }
  if (tag && npmVersion && tag !== expectedReleaseTag(npmVersion)) {
    errors.push(`release tag must equal ${expectedReleaseTag(npmVersion)}, got ${tag}`);
  }
  return errors;
}

function readReleaseVersions(repoRoot) {
  const root = path.resolve(repoRoot);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const tauriConfig = JSON.parse(
    fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')
  );
  return { packageVersion: packageJson.version, tauriVersion: tauriConfig.version };
}

if (require.main === module) {
  const versions = readReleaseVersions(path.resolve(__dirname, '..'));
  const errors = validateReleaseVersion({ tagName: process.env.GITHUB_REF_NAME, ...versions });
  if (errors.length > 0) {
    for (const error of errors) console.error(`[release-version] ${error}`);
    process.exit(1);
  }
  console.log(`[release-version] ok: ${process.env.GITHUB_REF_NAME}`);
}

module.exports = { expectedReleaseTag, readReleaseVersions, validateReleaseVersion };
