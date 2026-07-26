'use strict';

function stripEsmSyntax(source) {
  return source
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^import\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export\s*\{[\s\S]*?\};?\s*/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?function\b|class\b|const\b|let\b|var\b)/gm, '');
}

module.exports = { stripEsmSyntax };
