'use strict';

/**
 * Regression: the route-event context estimate must reflect the real request size.
 *
 * captureRequestBody() truncates stored text (default 120k chars) for audit safety.
 * The earlier code fed that truncated string to estimateTokens(), so every oversized
 * request reported the identical ceiling (~30000). A request that actually carried
 * ~1.7M prompt tokens (the "prompt is too long" incident) then looked harmless in the
 * route log, making the overflow impossible to see from diagnostics.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-context-estimate-'));
process.env.PROXY_CONFIG_DIR = path.join(runtimeDir, 'config');
process.env.PROXY_RUNTIME_DIR = path.join(runtimeDir, 'runtime');
process.env.NODE_ENV = 'test';

const { createRequestObservability } = require('../lib/proxy/request-observability');
const { captureRequestBody } = require('../lib/proxy/usage-report');
const { createDiagnostics } = require('../lib/proxy/diagnostics');
const { createClaudeFilters } = require('../lib/proxy/claude-filters');
const { estimateTokens } = require('../lib/proxy/request-utils');
const { parseBoundedInteger } = require('../lib/proxy/management-utils');

const routeEvents = [];
const claudeFilters = createClaudeFilters({
  protocolOptions: {},
  makeSafeClaudeToolUseContentBlock: () => ({ type: 'text', text: '' }),
});

const observability = createRequestObservability({
  appendAuditTextBounded: (current, addition) => String(current || '') + String(addition || ''),
  captureRequestBody,
  createClaudeFilters: () => claudeFilters,
  createDiagnostics,
  estimateTokens,
  getConfig: () => ({
    diagnostics: { enabled: true, captureGemini: true, captureOpenAI: true },
  }),
  getReqId: () => 'req_test',
  isClaudeProfile: () => false,
  isGeminiProfile: () => false,
  isQuietLocalPollRequest: () => false,
  logRouteModelMapping: (kind, method, upstreamPath, prepared) => {
    routeEvents.push({
      kind,
      method,
      path: upstreamPath,
      sourceModel: prepared.model,
      targetModel: prepared.rewriteTo,
      protocol: prepared.profile.protocol,
      profileId: prepared.profile.id,
      estimatedContextTokens: prepared.estimatedContextTokens || 0,
      contextEstimateTruncated: prepared.contextEstimateTruncated === true,
    });
  },
  metricsInstance: null,
  parseBoundedInteger,
  populateAuditDataFromPreparedWithDeps: () => {},
  protocolOptions: {},
  sanitizeGeminiToolCall: (call) => call,
});

function route(prepared, buffer) {
  routeEvents.length = 0;
  observability.logModelMapping('route', 'POST', '/v1/responses', prepared, buffer);
  assert.equal(routeEvents.length, 1, 'exactly one route event must be emitted');
  return routeEvents[0];
}

const profile = { id: 'deepseek', protocol: 'openai', name: 'deepseek' };

// Normal path: a small body is captured whole, so the estimate is char-based as before.
const smallBody = Buffer.from(JSON.stringify({ input: 'x'.repeat(400) }));
const small = route({ model: 'gpt-5', rewriteTo: '-', profile, buffer: smallBody }, null);
assert.equal(small.estimatedContextTokens, estimateTokens(smallBody.toString('utf8')));
assert.equal(small.contextEstimateTruncated, false);

// Truncated path: the old code reported a flat 30000 for any oversized request.
const hugeBody = Buffer.alloc(5 * 1024 * 1024, 0x7b);
const huge = route({ model: 'gpt-5', rewriteTo: '-', profile, buffer: hugeBody }, null);
assert.equal(huge.contextEstimateTruncated, true, 'oversized bodies must be flagged');
assert.equal(huge.estimatedContextTokens, Math.ceil(hugeBody.length / 4));
assert.ok(
  huge.estimatedContextTokens > 1000000,
  'oversized request must report its real magnitude, not the 30000 ceiling'
);
assert.notEqual(huge.estimatedContextTokens, 30000);

// Monotonicity: bigger request must never report a smaller estimate.
const midBody = Buffer.alloc(400000, 0x7b);
const mid = route({ model: 'gpt-5', rewriteTo: '-', profile, buffer: midBody }, null);
assert.ok(
  mid.estimatedContextTokens > small.estimatedContextTokens &&
    huge.estimatedContextTokens > mid.estimatedContextTokens,
  'context estimate must grow with request size instead of saturating'
);

fs.rmSync(runtimeDir, { recursive: true, force: true });
console.log('[context-token-estimate.test] ok');
