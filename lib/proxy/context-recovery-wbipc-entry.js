'use strict';

const { createContextRecoveryConversion } = require('./context-recovery-conversion');
const { normalizeRecoveryRequestBody } = require('./context-recovery-request-data');
const { recoveryHistoryRequestLimit } = require('./context-recovery-history-request');
const { recoveryWbipcCredentialsAllowed } = require('./context-recovery-auth');
const { createContextRecoveryWbipcDispatch } = require('./context-recovery-wbipc-dispatch');
const { readWorkBuddyWbipcEndpoint } = require('./workbuddy-wbipc-client');
const { tryHandleContextRecoveryHttp } = require('./context-recovery-http-entry');
const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const {
  fields,
  validateHistory,
  validateTools,
  validateChatCalls,
} = require('./context-recovery-conversion-guards');
const { decodeContextRecoveryEnvelope } = require('./context-recovery-protocol');
const { CONTEXT_ARTIFACT_TOOL_NAME } = require('./context-artifact-tool');
const { TOOL_DISCOVERY_NAME, TOOL_DISCOVERY_HEADER } = require('./context-tool-discovery-contract');

const HOSTS = new Set([
  'copilot.tencent.com',
  'www.workbuddy.cn',
  'workbuddy.cn',
  'www.codebuddy.ai',
  'codebuddy.ai',
  'www.codebuddy.cn',
  'codebuddy.cn',
]);
const invalid = () => new TypeError('Unsupported WBIPC recovery');
const legacyNames = new Set([CONTEXT_ARTIFACT_TOOL_NAME, TOOL_DISCOVERY_NAME]);
function rejectLegacyTools(body) {
  if (
    (body.tools || []).some((tool) => legacyNames.has(tool.function?.name)) ||
    (body.messages || []).some((message) =>
      message.tool_calls?.some((call) => legacyNames.has(call.function?.name))
    )
  )
    throw invalid();
}

function createWbipcConversion(kind, model, converters, historyFormat) {
  if (kind !== 'chat')
    return createContextRecoveryConversion({ kind, model, converters, historyFormat });
  return {
    upstreamKind: 'chat',
    encodeRequest(input) {
      const body = normalizeRecoveryRequestBody('chat', input, historyFormat);
      fields(body, [
        'model',
        'messages',
        'tools',
        'tool_choice',
        'stream',
        'temperature',
        'top_p',
        'max_tokens',
        'max_completion_tokens',
        'parallel_tool_calls',
        'service_tier',
      ]);
      if (
        typeof body.model !== 'string' ||
        !body.model.trim() ||
        (body.stream !== undefined && typeof body.stream !== 'boolean') ||
        ![undefined, 'auto'].includes(body.tool_choice) ||
        (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') ||
        (body.service_tier !== undefined &&
          !['auto', 'default', 'flex', 'priority'].includes(body.service_tier)) ||
        (body.max_tokens !== undefined && body.max_completion_tokens !== undefined)
      )
        throw invalid();
      for (const key of ['max_tokens', 'max_completion_tokens'])
        if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 1))
          throw invalid();
      for (const key of ['temperature', 'top_p'])
        if (
          body[key] !== undefined &&
          (typeof body[key] !== 'number' || body[key] < 0 || body[key] > (key === 'top_p' ? 1 : 2))
        )
          throw invalid();
      validateHistory('chat', body);
      validateTools('chat', body.tools);
      return { ...body, model, stream: false };
    },
    createDispatch(dispatch) {
      return async (input, options) => {
        const result = await dispatch(this.encodeRequest(input), options);
        const response = decodeContextRecoveryEnvelope('chat', result.wire, result.stream);
        const message = response.choices?.[0]?.message;
        fields(message, ['role', 'content', 'tool_calls', 'refusal']);
        if (
          message.refusal != null ||
          (message.content != null && typeof message.content !== 'string')
        )
          throw invalid();
        if (message.tool_calls !== undefined) validateChatCalls(message.tool_calls);
        return result;
      };
    },
  };
}

// Qualify before transferring observer ownership. After takeover the generic
// publisher is terminal: no legacy WBIPC handler or recovery loop is invoked.
function tryHandleContextRecoveryWbipc(options) {
  const { prepared, target, apiKey, requestOptions, label } = options;
  const kind =
    label === 'chat->wbipc'
      ? 'chat'
      : label === 'responses->chat'
        ? 'responses'
        : label === 'claude->openai'
          ? 'claude'
          : null;
  if (
    !kind ||
    apiKey ||
    !recoveryWbipcCredentialsAllowed(prepared) ||
    prepared.activePromptPreset ||
    prepared.promptPreset ||
    prepared.profile.optimizeContext === true ||
    target.protocol !== 'https:' ||
    !HOSTS.has(target.hostname) ||
    target.path !== '/v2' ||
    requestOptions.hostname !== target.hostname ||
    Number(requestOptions.port) !== 443 ||
    options.clientReq?.headers?.[TOOL_DISCOVERY_HEADER] !== undefined ||
    ![undefined, 'identity'].includes(options.clientReq?.headers?.['content-encoding']) ||
    !Buffer.isBuffer(prepared.buffer) ||
    prepared.buffer.length >
      (options.session?.historyFormat === 3 ? recoveryHistoryRequestLimit(3) : MAX_WIRE_BYTES)
  )
    return false;
  let conversion;
  let dispatch;
  try {
    const text = prepared.buffer.toString('utf8');
    if (!Buffer.from(text).equals(prepared.buffer)) return false;
    const body = JSON.parse(text);
    const model =
      prepared.rewriteTo && prepared.rewriteTo !== '-' ? prepared.rewriteTo : body.model;
    const historyFormat = options.session?.historyFormat ?? 2;
    conversion = createWbipcConversion(kind, model, options.converters, historyFormat);
    rejectLegacyTools(conversion.encodeRequest(body));
    const protocol = options.protocolOptions || {};
    const pinnedDispatch = createContextRecoveryWbipcDispatch({
      ...options.wbipc,
      readEndpoint: options.wbipc?.readEndpoint || readWorkBuddyWbipcEndpoint,
      authorized: options.authorized,
      path: '/v2/chat/completions',
      model,
      maxBodyBytes: protocol.workbuddyTargetBodyBytes,
      maxInputTokens: protocol.workbuddyOperationalInputTokens,
      timeoutMs: protocol.workbuddyWbipcTimeoutMs,
      historyFormat,
      reference: options.session?.retainedTransportReference,
    });
    dispatch = async (chat, controls) => {
      rejectLegacyTools(chat);
      const result = await pinnedDispatch(chat, controls);
      const source = decodeContextRecoveryEnvelope('chat', result.wire, result.stream);
      rejectLegacyTools({ messages: [source.choices?.[0]?.message || {}] });
      return result;
    };
  } catch {
    return false;
  }
  return tryHandleContextRecoveryHttp({
    ...options,
    kind,
    conversion,
    dispatch,
    requestOptions: { ...requestOptions, headers: {} },
  });
}

module.exports = { tryHandleContextRecoveryWbipc };
