const fs = require('fs');
const path = require('path');

const TRAE_ROOT =
  process.env.TRAE_INSTALL_ROOT || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Trae');

const TARGETS = [
  path.join(
    TRAE_ROOT,
    'resources',
    'app',
    'node_modules',
    '@byted-icube',
    'ai-modules-chat',
    'dist',
    'index.mjs'
  ),
  path.join(TRAE_ROOT, 'resources', 'app', 'out', 'vs', 'workbench', 'workbench.desktop.main.js'),
];

function findLatestBackup(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const backups = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.bak-https-proxy-raw-stream-`))
    .map((name) => path.join(dir, name))
    .sort();
  return backups[backups.length - 1] || null;
}

function restore(file) {
  const backup = findLatestBackup(file);
  if (!backup) {
    console.log(`no backup found: ${file}`);
    return;
  }
  fs.copyFileSync(backup, file);
  console.log(`restored: ${file}`);
  console.log(`from: ${backup}`);
}

for (const target of TARGETS) {
  restore(target);
}

console.log('Restart Trae to unload the raw stream probe.');
