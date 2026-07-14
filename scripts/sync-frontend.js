const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repoRoot = path.resolve(__dirname, '..');
const filePairs = [
  ['tauri-ui/electron-ui.html', 'electron-ui.html'],
  ['tauri-ui/app.css', 'app.css'],
  ['tauri-ui/app-ux.js', 'app-ux.js'],
  ['tauri-ui/app-bridge.js', 'app-bridge.js'],
  ['tauri-ui/app-audit.js', 'app-audit.js'],
  ['tauri-ui/app-cli.js', 'app-cli.js'],
  ['tauri-ui/app-diagnostics.js', 'app-diagnostics.js'],
  ['tauri-ui/app.js', 'app.js'],
];
const checkOnly = process.argv.includes('--check');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function normalizedSha256(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text).digest('hex');
}

function fail(message) {
  console.error(`[frontend-sync] ${message}`);
  process.exit(1);
}

function validateCanonicalHtml() {
  const htmlPath = path.join(repoRoot, 'tauri-ui', 'electron-ui.html');
  if (!fs.existsSync(htmlPath)) return;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const hasCss = /<link\s+rel=["']stylesheet["']\s+href=["']\.\/app\.css(?:\?[^"']*)?["']/.test(
    html
  );
  const bridgeMatch = html.match(
    /<script\s+defer\s+src=["']\.\/app-bridge\.js(?:\?[^"']*)?["']><\/script>/
  );
  const auditMatch = html.match(
    /<script\s+defer\s+src=["']\.\/app-audit\.js(?:\?[^"']*)?["']><\/script>/
  );
  const cliMatch = html.match(
    /<script\s+defer\s+src=["']\.\/app-cli\.js(?:\?[^"']*)?["']><\/script>/
  );
  const diagnosticsMatch = html.match(
    /<script\s+defer\s+src=["']\.\/app-diagnostics\.js(?:\?[^"']*)?["']><\/script>/
  );
  const appMatch = html.match(/<script\s+defer\s+src=["']\.\/app\.js(?:\?[^"']*)?["']><\/script>/);
  const bridgeIndex = bridgeMatch ? bridgeMatch.index : -1;
  const auditIndex = auditMatch ? auditMatch.index : -1;
  const cliIndex = cliMatch ? cliMatch.index : -1;
  const diagnosticsIndex = diagnosticsMatch ? diagnosticsMatch.index : -1;
  const appIndex = appMatch ? appMatch.index : -1;
  if (
    !hasCss ||
    bridgeIndex < 0 ||
    auditIndex < 0 ||
    cliIndex < 0 ||
    diagnosticsIndex < 0 ||
    appIndex < 0 ||
    bridgeIndex > auditIndex ||
    auditIndex > cliIndex ||
    cliIndex > diagnosticsIndex ||
    diagnosticsIndex > appIndex
  ) {
    fail(
      'tauri-ui/electron-ui.html must reference ./app.css, then ./app-bridge.js, then ./app-audit.js, then ./app-cli.js, then ./app-diagnostics.js, then ./app.js'
    );
  }
  if (/<style[\s>]/i.test(html)) {
    fail(
      'tauri-ui/electron-ui.html contains an inline <style> block; move CSS to tauri-ui/app.css'
    );
  }
  const inlineScripts =
    html.match(
      /<script(?!\s+defer\s+src=["']\.\/app-(?:ux|bridge|audit|cli|diagnostics)\.js(?:\?[^"']*)?["']><\/script>)(?!\s+defer\s+src=["']\.\/app\.js(?:\?[^"']*)?["']><\/script>)(?!\s+(?:async\s+)?src=["']https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js["']><\/script>)[\s>]/gi
    ) || [];
  if (inlineScripts.length > 0) {
    fail(
      'tauri-ui/electron-ui.html contains inline script tags; move JavaScript to tauri-ui/app.js'
    );
  }
}

validateCanonicalHtml();

let updated = 0;
let checked = 0;

for (const [canonicalRel, mirrorRel] of filePairs) {
  const canonical = path.join(repoRoot, canonicalRel);
  const mirror = path.join(repoRoot, mirrorRel);

  if (!fs.existsSync(canonical)) {
    fail(`canonical file missing: ${canonicalRel}`);
  }

  if (!fs.existsSync(mirror)) {
    if (checkOnly) {
      fail(`mirror file missing: ${mirrorRel}`);
    }
    fs.copyFileSync(canonical, mirror);
    console.log(`[frontend-sync] created ${mirrorRel} from ${canonicalRel}`);
    updated += 1;
    continue;
  }

  if (
    sha256(canonical) === sha256(mirror) ||
    normalizedSha256(canonical) === normalizedSha256(mirror)
  ) {
    checked += 1;
    continue;
  }

  if (checkOnly) {
    fail(`${mirrorRel} is out of sync with ${canonicalRel}. Run: npm run frontend:sync`);
  }

  fs.copyFileSync(canonical, mirror);
  console.log(`[frontend-sync] updated ${mirrorRel} from ${canonicalRel}`);
  updated += 1;
}

if (checkOnly) {
  console.log(`[frontend-sync] ok: ${checked} frontend mirror files match tauri-ui`);
} else if (updated === 0) {
  console.log('[frontend-sync] ok: frontend mirrors already match tauri-ui');
}
