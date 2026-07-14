const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const sourceDir = path.join(repoRoot, 'tauri-ui');
const outputDir = path.join(repoRoot, 'dist', 'tauri-ui');
const assets = [
  'app.css',
  'app-ux.js',
  'app-bridge.js',
  'app-audit.js',
  'app-cli.js',
  'app-diagnostics.js',
  'app.js',
];

function copyRequired(source, target) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing required frontend asset: ${path.relative(repoRoot, source)}`);
  }
  fs.copyFileSync(source, target);
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

copyRequired(path.join(sourceDir, 'electron-ui.html'), path.join(outputDir, 'index.html'));
copyRequired(path.join(sourceDir, 'electron-ui.html'), path.join(outputDir, 'electron-ui.html'));

for (const asset of assets) {
  copyRequired(path.join(sourceDir, asset), path.join(outputDir, asset));
}

console.log(`[tauri-dist] prepared ${path.relative(repoRoot, outputDir)}`);
