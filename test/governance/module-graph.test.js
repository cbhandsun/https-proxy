'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildModuleGraph,
  extractStaticImports,
  findCycles,
  resolveRelativeImport,
} = require('../../lib/governance/module-graph');

assert.deepEqual(
  extractStaticImports(`
    import './side-effect.js';
    import {
      alpha,
      beta,
    } from './dependency.js';
    export { gamma } from './exported.js';
    import external from 'external-package';
  `),
  ['./side-effect.js', './dependency.js', './exported.js', 'external-package']
);
assert.throws(() => extractStaticImports(null), /source must be a string/);

const acyclic = new Map([
  ['a', ['b']],
  ['b', ['c']],
  ['c', []],
]);
assert.deepEqual(findCycles(acyclic), []);

const cyclic = new Map([
  ['a', ['b']],
  ['b', ['c']],
  ['c', ['a']],
]);
assert.deepEqual(findCycles(cyclic), [['a', 'b', 'c', 'a']]);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-module-graph-'));
try {
  fs.writeFileSync(path.join(tempRoot, 'a.js'), "import './b.js';\n");
  fs.writeFileSync(path.join(tempRoot, 'b.js'), "import './a.js';\n");
  assert.equal(
    resolveRelativeImport(path.join(tempRoot, 'a.js'), './b'),
    path.join(tempRoot, 'b.js')
  );
  const graph = buildModuleGraph(tempRoot);
  assert.equal(graph.size, 2);
  assert.equal(findCycles(graph).length, 1);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('[module-graph.test] ok');
