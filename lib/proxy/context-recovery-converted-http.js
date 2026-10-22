'use strict';

const { isCodexResponsesTarget } = require('./responses-target');
const {
  nativeRecoveryProviderAllowed,
  tryHandleContextRecoveryHttp,
} = require('./context-recovery-http-entry');
const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const { recoveryHistoryRequestLimit } = require('./context-recovery-history-request');

// Qualification is completed before the observer is detached. Ineligible
// conversions retain their existing handler; failures after ownership do not.
function tryHandleContextRecoveryConvertedHttp(options) {
  const { label, prepared, target, apiKey, converters } = options;
  if (prepared.authMode === 'official-login' && prepared.authProvider === 'workbuddy') {
    const { tryHandleContextRecoveryWbipc } = require('./context-recovery-wbipc-entry');
    return tryHandleContextRecoveryWbipc(options);
  }
  const toResponses = ['chat->responses', 'claude->responses'].includes(label);
  const toMessages = ['openai->claude', 'responses->claude'].includes(label);
  const toGemini = ['openai->gemini', 'responses->gemini', 'claude->gemini'].includes(label);
  const kind = ['chat->responses', 'openai->claude', 'openai->gemini'].includes(label)
    ? 'chat'
    : ['responses->chat', 'responses->claude', 'responses->gemini'].includes(label)
      ? 'responses'
      : ['claude->openai', 'claude->responses', 'claude->gemini'].includes(label)
        ? 'claude'
        : null;
  if (
    !kind ||
    !converters ||
    (prepared.authMode === 'official-login' && !toResponses) ||
    prepared.activePromptPreset ||
    prepared.promptPreset ||
    prepared.profile.optimizeContext === true ||
    (toMessages &&
      (options.clientReq?.headers?.['anthropic-beta'] !== undefined ||
        ![undefined, '2023-06-01'].includes(options.clientReq?.headers?.['anthropic-version']))) ||
    !Buffer.isBuffer(prepared.buffer) ||
    prepared.buffer.length >
      (options.session?.historyFormat === 3 ? recoveryHistoryRequestLimit(3) : MAX_WIRE_BYTES)
  )
    return false;
  // Load only the qualified conversion family. Import failures remain outside
  // request-shape rejection so a broken installation cannot silently fall back.
  const factory = toGemini
    ? require('./context-recovery-gemini-conversion').createContextRecoveryGeminiConversion
    : toResponses
      ? require('./context-recovery-responses-conversion').createContextRecoveryResponsesConversion
      : toMessages
        ? require('./context-recovery-messages-conversion').createContextRecoveryMessagesConversion
        : require('./context-recovery-conversion').createContextRecoveryConversion;
  const createChatRequest =
    !toGemini && !toMessages
      ? require('./handlers/converted-chat-request').createConvertedChatRequest
      : null;
  let conversion;
  let requestOptions;
  try {
    const text = prepared.buffer.toString('utf8');
    if (!Buffer.from(text).equals(prepared.buffer)) return false;
    const body = JSON.parse(text);
    const targetModel =
      prepared.rewriteTo && prepared.rewriteTo !== '-' ? prepared.rewriteTo : body.model;
    conversion = factory({
      kind,
      model: targetModel,
      converters,
      historyFormat: options.session?.historyFormat ?? 2,
      ...(toResponses ? { codex: isCodexResponsesTarget(prepared.profile, target) } : {}),
    });
    conversion.encodeRequest(body);
    requestOptions = {
      ...options.requestOptions,
      path: toGemini
        ? (target.path || '').replace(/\/$/, '').replace(/\/v1$/, '') +
          '/v1beta/models/' +
          encodeURIComponent(targetModel) +
          ':generateContent'
        : target.path +
          (toResponses ? '/responses' : toMessages ? '/messages' : '/chat/completions'),
      headers: toGemini
        ? {
            'content-type': 'application/json',
            ...(apiKey
              ? apiKey.startsWith('ya29.')
                ? { authorization: 'Bearer ' + apiKey }
                : { 'x-goog-api-key': apiKey }
              : {}),
          }
        : toMessages
          ? {
              'content-type': 'application/json',
              'anthropic-version': '2023-06-01',
              ...(apiKey ? { 'x-api-key': apiKey } : {}),
            }
          : createChatRequest(prepared, target, apiKey, prepared.buffer).headers,
    };
    const providerAllowed = options.providerAllowed || nativeRecoveryProviderAllowed;
    if (
      !providerAllowed({
        kind: conversion.upstreamKind,
        target,
        path: requestOptions.path,
        prepared,
        requestOptions,
      })
    )
      return false;
  } catch {
    return false;
  }
  return tryHandleContextRecoveryHttp({ ...options, kind, conversion, requestOptions });
}

module.exports = { tryHandleContextRecoveryConvertedHttp };
