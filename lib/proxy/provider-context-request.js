'use strict';

const {
  applyOpenAIContextManagement,
  isNativeOpenAIResponsesTarget,
} = require('./openai-context-management');
const {
  applyAnthropicContextManagement,
  mergeAnthropicBetaHeader,
} = require('./anthropic-context-management');

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidRequest() {
  const error = new TypeError('Provider context request could not be processed safely');
  error.code = 'invalid_request_error';
  return error;
}

function parseBody(prepared) {
  if (!Buffer.isBuffer(prepared?.buffer)) throw invalidRequest();
  try {
    const body = JSON.parse(prepared.buffer.toString('utf8'));
    if (!record(body)) throw invalidRequest();
    return body;
  } catch (error) {
    if (error?.code === 'invalid_request_error') throw error;
    throw invalidRequest();
  }
}

function attachDiagnostics(body, contextManagement) {
  const existing = body.__hpmDiagnostics;
  const diagnostics = record(existing) ? existing : {};
  diagnostics.providerContext = {
    applied: contextManagement.applied === true,
    explicit: contextManagement.explicit === true,
    reason: String(contextManagement.reason || 'unknown'),
  };
  Object.defineProperty(body, '__hpmDiagnostics', {
    value: diagnostics,
    enumerable: false,
    configurable: true,
  });
}

function normalizeProviderContextRequest(prepared, options = {}) {
  if (!prepared || options.requestEncoding) return prepared;
  const isResponses = options.isResponsesRequest === true;
  const isClaude =
    options.isClaudeMessagesRequest === true || options.isClaudeTokenCountRequest === true;
  if (!isResponses && !isClaude) return prepared;
  const profile = prepared.profile || options.profile;
  const target = options.target;
  if (isResponses && !isNativeOpenAIResponsesTarget(profile, target)) return prepared;

  const body = parseBody(prepared);
  let contextManagement;
  let anthropicBetas = [];
  if (isResponses) {
    contextManagement = applyOpenAIContextManagement(body, {
      profile,
      target,
      policy: options.protocolOptions?.openAIContextManagementPolicy,
      compactThreshold: options.protocolOptions?.openAICompactionThreshold,
    });
  } else {
    contextManagement = applyAnthropicContextManagement(body, {
      profile,
      target,
      policy: options.protocolOptions?.anthropicContextManagementPolicy,
      compactionTrigger: options.protocolOptions?.anthropicCompactionTrigger,
    });
    if (contextManagement.reason === 'unsupported-target') return prepared;
    anthropicBetas = contextManagement.betas;
  }
  attachDiagnostics(body, contextManagement);
  return {
    ...prepared,
    buffer: Buffer.from(JSON.stringify(body)),
    bodyChanged: true,
    contextManagement: {
      provider: isResponses ? 'openai' : 'anthropic',
      applied: contextManagement.applied === true,
      explicit: contextManagement.explicit === true,
      reason: contextManagement.reason,
      betas: anthropicBetas,
    },
  };
}

function applyProviderContextHeaders(headers, prepared) {
  if (!record(headers)) throw invalidRequest();
  const contextManagement = prepared?.contextManagement;
  if (contextManagement?.provider !== 'anthropic' || !contextManagement.betas?.length)
    return headers;
  headers['anthropic-beta'] = mergeAnthropicBetaHeader(
    headers['anthropic-beta'],
    contextManagement.betas
  );
  return headers;
}

module.exports = { applyProviderContextHeaders, normalizeProviderContextRequest };
