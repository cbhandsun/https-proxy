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

// ─── 6. parseTargetUrl normalizes ports and provider base paths ───
{
  const explicit = routing.parseTargetUrl('https://example.com:8443/v1/');
  assert.deepEqual(explicit, {
    protocol: 'https:',
    hostname: 'example.com',
    port: 8443,
    path: '/v1',
  });

  assert.equal(
    routing.parseTargetUrl('https://example.com/custom').port,
    443,
    'https default port'
  );
  assert.equal(routing.parseTargetUrl('http://example.com/custom').port, 80, 'http default port');
  assert.equal(
    routing.parseTargetUrl('https://api.openai.com').path,
    '/v1',
    'known OpenAI host defaults to /v1'
  );
}

// ─── 7. parseTargetUrl returns cache copies, not shared objects ───
{
  const first = routing.parseTargetUrl('https://cache-copy.example/v1');
  first.port = 1;
  const second = routing.parseTargetUrl('https://cache-copy.example/v1');
  assert.equal(second.port, 443, 'cached target URL result is cloned on read');
}

// ─── 8. conversation audit paths exclude local token counters ────
{
  assert.equal(
    routing.isConversationRequestPath('POST', '/v1/messages'),
    true,
    'Claude messages are conversation requests'
  );
  assert.equal(
    routing.isConversationRequestPath('POST', '/v1/messages?beta=true'),
    true,
    'Claude messages with query are conversation requests'
  );
  assert.equal(
    routing.isConversationRequestPath('POST', '/v1/messages/count_tokens?beta=true'),
    false,
    'count_tokens is a local helper request, not a conversation'
  );
  assert.equal(routing.isOpenAIInputTokensPath('/v1/responses/input_tokens'), true);
  assert.equal(routing.isOpenAIInputTokensPath('/v1/responses/input_tokens_extra'), false);
  assert.equal(
    routing.isConversationRequestPath('GET', '/v1/messages'),
    false,
    'non-POST messages requests are not conversations'
  );
  assert.equal(
    routing.isConversationRequestPath('POST', '/v1/images/generations'),
    true,
    'OpenAI image generations are audited requests'
  );
  assert.equal(routing.isOpenAIImagesGenerationsPath('/images/generations?x=1'), true);
  assert.equal(routing.isOpenAIImageJobsCollectionPath('/v1/image-jobs?x=1'), true);
  assert.equal(
    routing.parseOpenAIImageJobId('/v1/image-jobs/imgjob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?x=1'),
    'imgjob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  );
  assert.equal(routing.parseOpenAIImageJobId('/v1/image-jobs/not-a-job'), null);
  assert.equal(routing.isOpenAIImageJobsPath('/image-jobs'), true);
  assert.equal(
    routing.isConversationRequestPath('POST', '/v1/image-jobs'),
    true,
    'Image job creation is audited without auditing result polling'
  );
  assert.equal(routing.isConversationRequestPath('GET', '/v1/image-jobs'), false);
}

// ─── 9. prepareRequestBuffer handles compressed bodies and Codex hint headers ───
{
  const zlib = require('node:zlib');
  const profiles = [
    { id: 'openai-official', name: 'OpenAI Official', protocol: 'openai' },
    { id: 'deepseek', name: 'DeepSeek', protocol: 'claude' },
  ];
  const routes = [
    { from: 'gpt-6.1-sol', profileId: 'openai-official', to: 'gpt-6.1-sol' },
    { from: 'codex/rewritten', profileId: 'openai-official', to: 'rewritten-target' },
  ];
  const activeProfile = profiles[1]; // default is deepseek (claude)
  const resolver = (model) => routing.resolveRoute(model, routes, profiles, activeProfile);

  // 9a: zstd compressed body with x-codex-routing-hint
  const rawPayload = JSON.stringify({ model: 'gpt-6.1-sol', input: 'test' });
  const compressed =
    typeof zlib.zstdCompressSync === 'function'
      ? zlib.zstdCompressSync(Buffer.from(rawPayload))
      : zlib.gzipSync(Buffer.from(rawPayload));
  const encoding = typeof zlib.zstdCompressSync === 'function' ? 'zstd' : 'gzip';

  const preparedWithHint = routing.prepareRequestBuffer(
    compressed,
    encoding,
    activeProfile,
    resolver,
    { headers: { 'x-codex-routing-hint': 'model=gpt-6.1-sol' } }
  );
  assert.equal(preparedWithHint.model, 'gpt-6.1-sol', 'model resolved via hint');
  assert.equal(preparedWithHint.routed, true, 'route matched');
  assert.equal(
    preparedWithHint.profile.id,
    'openai-official',
    'profile resolved to openai-official'
  );
  assert.equal(
    preparedWithHint.buffer,
    compressed,
    'original compressed buffer preserved for passthrough'
  );

  // 9b: zstd compressed body without hint header (extract from decompressed body)
  const preparedWithoutHint = routing.prepareRequestBuffer(
    compressed,
    encoding,
    activeProfile,
    resolver,
    {}
  );
  assert.equal(preparedWithoutHint.model, 'gpt-6.1-sol', 'model resolved via decompression');
  assert.equal(
    preparedWithoutHint.profile.id,
    'openai-official',
    'profile resolved to openai-official'
  );

  // 9c: compressed body with rewrite
  const rewritePayload = JSON.stringify({ model: 'codex/rewritten', input: 'test' });
  const rewriteCompressed =
    typeof zlib.zstdCompressSync === 'function'
      ? zlib.zstdCompressSync(Buffer.from(rewritePayload))
      : zlib.gzipSync(Buffer.from(rewritePayload));
  const preparedWithRewrite = routing.prepareRequestBuffer(
    rewriteCompressed,
    encoding,
    activeProfile,
    resolver,
    {}
  );
  assert.equal(preparedWithRewrite.model, 'codex/rewritten');
  assert.equal(preparedWithRewrite.rewriteTo, 'rewritten-target');
  assert.equal(preparedWithRewrite.decompressed, true);
  const rewrittenBody = JSON.parse(preparedWithRewrite.buffer.toString('utf8'));
  assert.equal(rewrittenBody.model, 'rewritten-target');
}

clearCaches();
console.log('routing.test.js ok (9 scenarios)');
