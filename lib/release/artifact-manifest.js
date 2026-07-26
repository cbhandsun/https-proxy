'use strict';

const path = require('path');

function validateArtifactManifest(manifest, filesByName) {
  const errors = [];
  if (!Array.isArray(manifest) || manifest.length === 0) {
    return ['artifact manifest must contain at least one entry'];
  }
  const seen = new Set();
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push('artifact manifest entry must be an object');
      continue;
    }
    const file = String(entry.file || '');
    if (!file || path.basename(file) !== file || seen.has(file)) {
      errors.push(`artifact manifest has invalid or duplicate file: ${file}`);
      continue;
    }
    seen.add(file);
    const actual = filesByName[file];
    if (!actual) {
      errors.push(`artifact is missing: ${file}`);
      continue;
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes !== actual.bytes) {
      errors.push(`artifact size mismatch: ${file}`);
    }
    if (!/^[a-f0-9]{64}$/i.test(String(entry.sha256 || '')) || entry.sha256 !== actual.sha256) {
      errors.push(`artifact checksum mismatch: ${file}`);
    }
  }
  for (const file of Object.keys(filesByName)) {
    if (!seen.has(file)) errors.push(`artifact is not listed in manifest: ${file}`);
  }
  return errors;
}

module.exports = { validateArtifactManifest };
