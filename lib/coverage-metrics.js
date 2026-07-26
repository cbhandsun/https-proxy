'use strict';

function percentage(covered, total) {
  return total === 0 ? 100 : Math.floor((covered / total) * 10000) / 100;
}

function collectCoverageMetrics(coverageByFile, includeFile = () => true) {
  const totals = {
    statements: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
    lines: { covered: 0, total: 0 },
  };

  for (const [filePath, entry] of Object.entries(coverageByFile || {})) {
    if (!includeFile(filePath) || !entry || typeof entry !== 'object') continue;

    for (const count of Object.values(entry.s || {})) {
      totals.statements.total += 1;
      if (Number(count) > 0) totals.statements.covered += 1;
    }
    for (const count of Object.values(entry.f || {})) {
      totals.functions.total += 1;
      if (Number(count) > 0) totals.functions.covered += 1;
    }
    for (const counts of Object.values(entry.b || {})) {
      for (const count of Array.isArray(counts) ? counts : []) {
        totals.branches.total += 1;
        if (Number(count) > 0) totals.branches.covered += 1;
      }
    }

    const lineCounts = new Map();
    for (const [statementId, location] of Object.entries(entry.statementMap || {})) {
      const line = Number(location?.start?.line);
      if (!Number.isInteger(line) || line <= 0) continue;
      const count = Number(entry.s?.[statementId] || 0);
      lineCounts.set(line, Math.max(lineCounts.get(line) || 0, count));
    }
    totals.lines.total += lineCounts.size;
    totals.lines.covered += Array.from(lineCounts.values()).filter((count) => count > 0).length;
  }

  return Object.fromEntries(
    Object.entries(totals).map(([name, value]) => [
      name,
      { ...value, percentage: percentage(value.covered, value.total) },
    ])
  );
}

module.exports = { collectCoverageMetrics, percentage };
