const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const skippedDirs = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
]);

function collectJsFiles(dir, output) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skippedDirs.has(entry.name)) continue;
      collectJsFiles(path.join(dir, entry.name), output);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      output.push(path.join(dir, entry.name));
    }
  }
}

const files = [];
collectJsFiles(repoRoot, files);

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log(`[syntax] ok: ${files.length} JavaScript files`);
