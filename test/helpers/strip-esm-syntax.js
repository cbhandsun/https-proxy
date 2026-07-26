'use strict';

function stripEsmSyntax(source) {
  return source
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^import\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export\s*\{[\s\S]*?\};?\s*/gm, '');
}

module.exports = { stripEsmSyntax };
