'use strict';
const geminiServiceTier = Symbol('validatedGeminiServiceTier');
function invalidTier() {
  const error = new TypeError(
    'Requested service tier cannot be preserved by this conversion target'
  );
  error.code = 'invalid_request_error';
  throw error;
}
function validateGeminiServiceTier(value, options = {}) {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !['unspecified', 'standard', 'priority', 'flex'].includes(value))
    invalidTier();
  // Code Assist has no serviceTier field. Accept valid client preferences using
  // provider default scheduling; the request builder records this compatibility fallback.
  if (options.codeAssist === true) return undefined;
  return value;
}
function convertedServiceTier(value, source, target, options = {}) {
  if (value == null) return null;
  if (typeof value !== 'string' || !['openai', 'claude'].includes(source)) invalidTier();
  const tier = value.trim();
  const canonical = source === 'claude' && tier === 'standard_only' ? 'default' : tier;
  if (!['auto', 'default', 'priority', 'flex'].includes(canonical)) invalidTier();
  if (target === 'Claude') {
    if (!['auto', 'default'].includes(canonical)) invalidTier();
    return canonical === 'auto' ? 'auto' : 'standard_only';
  }
  if (target === 'Gemini')
    return validateGeminiServiceTier(
      { auto: 'unspecified', default: 'standard', priority: 'priority', flex: 'flex' }[canonical],
      options
    );
  if (target === 'Chat' || target === 'Responses') return canonical;
  invalidTier();
}
function applyConvertedServiceTier(config, body, source, target) {
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body)
  )
    invalidTier();
  const tier = convertedServiceTier(body.service_tier, source, target);
  if (tier != null) {
    if (target === 'Gemini') config[geminiServiceTier] = tier;
    else config.service_tier = tier;
  }
  return config;
}
module.exports = {
  convertedServiceTier,
  applyConvertedServiceTier,
  geminiServiceTier,
  validateGeminiServiceTier,
};
