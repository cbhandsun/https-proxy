const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const skippedDirs = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target']);
const maxWorkers = Math.max(1, Math.min(8, os.availableParallelism?.() || os.cpus().length || 1));

function shouldSkipDirectory(name) {
  return skippedDirs.has(name) || name.startsWith('target-');
}

function collectJsFiles(dir, output) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name)) continue;
      collectJsFiles(path.join(dir, entry.name), output);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      output.push(path.join(dir, entry.name));
    }
  }
}

function checkFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', file], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', (error) => resolve({ file, error, output }));
    child.on('close', (code) => resolve({ file, code, output }));
  });
}

async function main() {
  const files = [];
  collectJsFiles(repoRoot, files);
  files.sort();

  let nextIndex = 0;
  let failure = null;
  async function worker() {
    while (!failure && nextIndex < files.length) {
      const file = files[nextIndex++];
      const result = await checkFile(file);
      if (result.error || result.code !== 0) failure = result;
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxWorkers, files.length) }, worker));
  if (failure) {
    if (failure.output) process.stderr.write(failure.output);
    console.error(`[syntax] failed: ${path.relative(repoRoot, failure.file)}`);
    process.exitCode = failure.code || 1;
    return;
  }
  console.log(`[syntax] ok: ${files.length} JavaScript files (${maxWorkers} workers)`);
}

main().catch((error) => {
  console.error(`[syntax] ${error.message}`);
  process.exitCode = 1;
});
