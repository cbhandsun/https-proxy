'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fail = () => new Error('context_hosted_source_identity_rejected');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function parseTrackedFiles(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 16777216) throw fail();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\0')) throw fail();
  const names = text.slice(0, -1).split('\0');
  if (
    names.length > 20000 ||
    new Set(names.map((name) => name.toLowerCase())).size !== names.length
  )
    throw fail();
  for (const name of names)
    if (
      !name ||
      path.isAbsolute(name) ||
      name.includes('\\') ||
      [...name].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      name.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw fail();
  return names.sort();
}
function captureSourceIdentity(candidate, sourceSha) {
  try {
    if (
      typeof candidate !== 'string' ||
      !path.isAbsolute(candidate) ||
      typeof sourceSha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(sourceSha)
    )
      throw fail();
    const git = (args) => {
      const result = spawnSync('git', ['-C', candidate, ...args], {
        shell: false,
        windowsHide: true,
        encoding: null,
        maxBuffer: 16777216,
        timeout: 15000,
      });
      if (result.error || result.signal || result.status !== 0 || !Buffer.isBuffer(result.stdout))
        throw fail();
      return result.stdout;
    };
    if (git(['rev-parse', 'HEAD']).toString('ascii').trim() !== sourceSha) throw fail();
    git(['diff', '--quiet', 'HEAD', '--']);
    const names = parseTrackedFiles(git(['ls-files', '-z']));
    const entries = names.map((name) => {
      const file = path.join(candidate, name),
        stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail();
      return { path: name, sha256: sha(fs.readFileSync(file)) };
    });
    return Object.freeze({
      schemaVersion: 1,
      sourceSha,
      sourceEntries: entries.length,
      sourceIdentity: sha(JSON.stringify(entries)),
      entries,
    });
  } catch {
    throw fail();
  }
}
module.exports = { captureSourceIdentity, parseTrackedFiles };
