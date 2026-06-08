// Tests for lib/proxy/routing.js — focused on rebuildRouteIndex, the
// hot-reload entry point that fixes the legacy `typeof _indexCache` bug.

const assert = require('node:assert/strict');

const routing = require('../lib/proxy/routing');

const routesA = [
  { from: 'gpt-4*', to: 'gpt-4o', profileId: 'p-openai', enabled: true },
  { from: 'claude-3*', to: 'claude-3-5-sonnet', profileId: 'p-claude', enabled: true },
];
const routesB = [
  { from: 'gpt-4*', to: 'gpt-4-turbo', profileId: 'p-openai', enabled: true },
  { from: 'gemini-*', to: 'gemini-1.5-pro', profileId: 'p-gemini', enabled: true },
];

function clearCaches() {
  routing.resetRouteIndex();
}

function pickProfiles() {
  return [
    { id: 'p-openai', name: 'OpenAI', protocol: 'openai', targetUrl: 'https://api.openai.com/v1' },
    { id: 'p-claude', name: 'Claude', protocol: 'claude', targetUrl: 'https://api.anthropic.com' },
    {
      id: 'p-gemini',
      name: 'Gemini',
      protocol: 'gemini',
      targetUrl: 'https://generativelanguage.googleapis.com',
    },
  ];
}

clearCaches();

// ─── 1. resolveRoute uses the indexed lookup ─────────────────────
{
  clearCaches();
  const resolved = routing.resolveRoute('gpt-4-turbo', routesA, pickProfiles(), pickProfiles()[0]);
  assert.equal(resolved.route.to, 'gpt-4o', 'wildcard route resolved via index');
  assert.equal(resolved.profile.id, 'p-openai', 'profile matched');
}

// ─── 2. rebuildRouteIndex refreshes the cached index ─────────────
{
  clearCaches();
  // prime cache for routesA
  const before = routing.resolveRoute('gpt-4-turbo', routesA, pickProfiles(), pickProfiles()[0]);
  assert.equal(before.route.to, 'gpt-4o', 'before rebuild: gpt-4o');

  // hot-swap to routesB and rebuild
  const rebuilt = routing.rebuildRouteIndex(routesB);
  assert.equal(rebuilt, true, 'rebuildRouteIndex returns true');

  const after = routing.resolveRoute('gpt-4-turbo', routesB, pickProfiles(), pickProfiles()[0]);
  assert.equal(after.route.to, 'gpt-4-turbo', 'after rebuild: gpt-4-turbo (no rewrite)');
}

// ─── 3. rebuildRouteIndex survives a no-change rebuild ───────────
{
  clearCaches();
  routing.resolveRoute('gpt-4-turbo', routesA, pickProfiles(), pickProfiles()[0]);
  const rebuilt = routing.rebuildRouteIndex(routesA);
  assert.equal(rebuilt, true, 'rebuildRouteIndex on same routes is true');
  const after = routing.resolveRoute('gpt-4-turbo', routesA, pickProfiles(), pickProfiles()[0]);
  assert.equal(after.route.to, 'gpt-4o', 'route still resolves correctly after no-op rebuild');
}

// ─── 4. rebuildRouteIndex creates an index when none exists ──────
{
  clearCaches();
  const rebuilt = routing.rebuildRouteIndex(routesB);
  assert.equal(rebuilt, true, 'cold rebuild returns true');
  const after = routing.resolveRoute('gemini-pro', routesB, pickProfiles(), pickProfiles()[2]);
  assert.equal(after.route.to, 'gemini-1.5-pro', 'cold-rebuilt index resolves new route');
}

// ─── 5. resetRouteIndex forces the next access to rebuild ────────
{
  clearCaches();
  routing.resolveRoute('gpt-4-turbo', routesA, pickProfiles(), pickProfiles()[0]);
  routing.resetRouteIndex();
  // After reset, the next resolveRoute should rebuild for whatever routes it sees.
  const after = routing.resolveRoute('gemini-pro', routesB, pickProfiles(), pickProfiles()[2]);
  assert.equal(after.route.to, 'gemini-1.5-pro', 'reset + new routes work');
}

clearCaches();
console.log('routing.test.js ok (5 scenarios)');
