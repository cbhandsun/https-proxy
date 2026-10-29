'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const refused = () => new Error('Plugin generated module boundary refused');
function readGeneratedPluginModules(plugin) {
  const file = path.join(plugin, 'runtime-manifest.json');
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw refused();
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    !manifest ||
    manifest.schema !== 'hpm.context.plugin-closure' ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 512
  )
    throw refused();
  const seen = new Set();
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      entry.path.length > 1024 ||
      !/^lib\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.js$/.test(entry.path) ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      seen.has(entry.path)
    )
      throw refused();
    seen.add(entry.path);
  }
  return manifest.files;
}

// Only a prior manifest can establish ownership. Refuse changed files and
// linked paths rather than deleting user edits or reaching another directory.
function retireGeneratedPluginModules(runtime, previous, current) {
  const stale = [];
  for (const entry of previous) {
    if (current.has(entry.path)) continue;
    let file = path.resolve(runtime);
    const names = entry.path.split('/');
    const components = [file];
    for (const name of names) {
      file = path.join(file, name);
      components.push(file);
    }
    let missing = false;
    for (let index = 0; index < components.length; index++) {
      let stat;
      try {
        stat = fs.lstatSync(components[index]);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missing = true;
        break;
      }
      if (
        stat.isSymbolicLink() ||
        (index === components.length - 1 ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
      )
        throw refused();
    }
    if (missing) continue;
    const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (digest !== entry.sha256) throw refused();
    stale.push(file);
  }
  // Validate every candidate before removing any. Never recursively delete a
  // directory or infer ownership of an unlisted file.
  for (const file of stale) fs.unlinkSync(file);
  return stale.length;
}

module.exports = { readGeneratedPluginModules, retireGeneratedPluginModules };
