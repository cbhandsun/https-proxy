'use strict';

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sortedUnique(values) {
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const item = cleanString(value);
    if (item) seen.add(item);
  }
  return Array.from(seen).sort();
}

function diffModelNames(expected, actual) {
  const expectedSet = new Set(sortedUnique(expected));
  const actualSet = new Set(sortedUnique(actual));
  return {
    missing: Array.from(expectedSet)
      .filter((name) => !actualSet.has(name))
      .sort(),
    stale: Array.from(actualSet)
      .filter((name) => !expectedSet.has(name))
      .sort(),
  };
}

function normalizeInferenceModelName(model) {
  if (typeof model === 'string') return cleanString(model);
  if (model && typeof model === 'object') return cleanString(model.name);
  return '';
}

// Pure comparison so the management layer stays a thin composition root.
function computeClaudeDesktopDrift({
  expectedModels,
  actualModels,
  expectedBaseUrl,
  actualBaseUrl,
  tokenMatchesExpected,
} = {}) {
  const { missing, stale } = diffModelNames(
    (Array.isArray(expectedModels) ? expectedModels : []).map(normalizeInferenceModelName),
    (Array.isArray(actualModels) ? actualModels : []).map(normalizeInferenceModelName)
  );
  const expectedUrl = cleanString(expectedBaseUrl);
  const actualUrl = cleanString(actualBaseUrl);
  const baseUrlMatches = expectedUrl || actualUrl ? expectedUrl === actualUrl : true;
  const tokenMatches = tokenMatchesExpected !== false;
  return {
    baseUrlMatches,
    tokenMatches,
    missingModels: missing,
    staleModels: stale,
    missingModelCount: missing.length,
    staleModelCount: stale.length,
    modelCountMatches: missing.length === 0 && stale.length === 0,
    inSync: baseUrlMatches && tokenMatches && missing.length === 0 && stale.length === 0,
  };
}

// Only compare when the shared Codex config is actually pointed at the local proxy and
// the managed catalog is the active one; official/direct setups must not report drift.
function computeCodexDesktopDrift({
  expectedBaseUrl,
  actualBaseUrl,
  catalogSlugs,
  routeSlugs,
  proxyConfigured = true,
  managedCatalog = true,
} = {}) {
  const expectedUrl = cleanString(expectedBaseUrl);
  const actualUrl = cleanString(actualBaseUrl);
  const baseUrlMatches =
    proxyConfigured === false ? true : expectedUrl || actualUrl ? expectedUrl === actualUrl : true;
  // Without a known route list there is nothing authoritative to compare against.
  const comparable = managedCatalog !== false && Array.isArray(routeSlugs);
  const { missing, stale } = comparable
    ? diffModelNames(routeSlugs, catalogSlugs)
    : { missing: [], stale: [] };
  return {
    baseUrlMatches,
    missingCatalogSlugs: missing,
    staleCatalogSlugs: stale,
    catalogMatchesRoutes: missing.length === 0 && stale.length === 0,
    inSync: baseUrlMatches && missing.length === 0 && stale.length === 0,
  };
}

module.exports = {
  cleanString,
  sortedUnique,
  diffModelNames,
  normalizeInferenceModelName,
  computeClaudeDesktopDrift,
  computeCodexDesktopDrift,
};
