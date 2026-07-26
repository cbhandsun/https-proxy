'use strict';

const fs = require('node:fs');
const path = require('node:path');

function extractStaticImports(source) {
  if (typeof source !== 'string') throw new TypeError('source must be a string');
  const matches = [];
  const patterns = [
    /(?:^|\r?\n)\s*import\s*['"]([^'"\r\n]+)['"]\s*;?/g,
    /(?:^|\r?\n)\s*(?:import|export)\s+(?!['"])[\s\S]*?\s+from\s+['"]([^'"\r\n]+)['"]\s*;?/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      matches.push({ index: match.index, specifier: match[1] });
    }
  }
  return matches.sort((left, right) => left.index - right.index).map((match) => match.specifier);
}

function listJavaScriptFiles(rootDir) {
  const files = [];
  function visit(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolute = path.join(currentDir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
    }
  }
  visit(rootDir);
  return files.sort();
}

function resolveRelativeImport(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const unresolved = path.resolve(path.dirname(importer), specifier);
  const candidates = [unresolved, `${unresolved}.js`, path.join(unresolved, 'index.js')];
  return candidates.find((candidate) => fs.existsSync(candidate)) || unresolved;
}

function buildModuleGraph(rootDir) {
  const absoluteRoot = path.resolve(rootDir);
  const files = listJavaScriptFiles(absoluteRoot);
  const fileSet = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const dependencies = extractStaticImports(fs.readFileSync(file, 'utf8'))
      .map((specifier) => resolveRelativeImport(file, specifier))
      .filter((dependency) => dependency && fileSet.has(dependency))
      .sort();
    graph.set(file, dependencies);
  }
  return graph;
}

function canonicalCycle(cycle) {
  const nodes = cycle.slice(0, -1);
  const rotations = nodes.map((_, index) => nodes.slice(index).concat(nodes.slice(0, index)));
  rotations.sort((left, right) => left.join('\0').localeCompare(right.join('\0')));
  const canonical = rotations[0];
  return canonical.concat(canonical[0]);
}

function findCycles(graph) {
  const cycles = new Map();
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(node) {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = canonicalCycle(stack.slice(start).concat(node));
      cycles.set(cycle.join('\0'), cycle);
      return;
    }
    if (visited.has(node)) return;

    visiting.add(node);
    stack.push(node);
    for (const dependency of graph.get(node) || []) visit(dependency);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of [...graph.keys()].sort()) visit(node);
  return [...cycles.values()].sort((left, right) =>
    left.join('\0').localeCompare(right.join('\0'))
  );
}

module.exports = {
  buildModuleGraph,
  extractStaticImports,
  findCycles,
  listJavaScriptFiles,
  resolveRelativeImport,
};
