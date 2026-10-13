'use strict';

const { stringifyWithoutInlineMedia } = require('./inline-media');
const MAX_TEXTUALIZED_TOOL_HISTORY_CHARS = 12000;
function truncateHistory(value) {
  const text = String(value == null ? '' : value);
  return text.length <= MAX_TEXTUALIZED_TOOL_HISTORY_CHARS
    ? text
    : text.slice(0, MAX_TEXTUALIZED_TOOL_HISTORY_CHARS - 24) + '\n[truncated]';
}

// Both request adapters use semantic tool descriptors. Provider signature and
// declaration policy belongs here rather than in a client protocol envelope.
function createGeminiNativeToolHistory({
  getCall,
  rememberCall,
  cleanToolArgs,
  safeName,
  signature,
}) {
  function resultName(result) {
    return safeName(getCall(result.id)?.name || result.name || result.id || 'tool_result');
  }
  function declared(name, options) {
    return (
      options.declaredFunctionNames instanceof Set &&
      options.declaredFunctionNames.has(name) &&
      !(options.managedWebSearchHistoryAsText === true && name === 'web_search')
    );
  }
  function callText(call) {
    const name = safeName(call.name || 'tool_call');
    const args = cleanToolArgs(call.name, call.args || {});
    rememberCall(call.id, name, args, signature);
    return {
      text: truncateHistory(
        'Previous tool call (' + name + '):\n' + stringifyWithoutInlineMedia(args)
      ),
    };
  }
  function resultText(result) {
    const name = safeName(getCall(result.id)?.name || result.name || 'tool_result');
    return {
      text: truncateHistory(
        (result.error ? 'Previous tool error' : 'Previous tool result') +
          ' (' +
          name +
          '):\n' +
          result.text
      ),
    };
  }
  function callPart(call, options = {}) {
    const cached = getCall(call.id) || {};
    const rawName = cached.name || call.name;
    const name = safeName(rawName);
    const args = cached.args || cleanToolArgs(rawName, call.args || {});
    const thoughtSignature = cached.thoughtSignature || signature;
    rememberCall(call.id, name, args, thoughtSignature);
    return {
      functionCall: {
        name,
        args,
        ...(options.preserveIds && call.id ? { id: cached.providerId || call.id } : {}),
      },
      thoughtSignature,
    };
  }
  function resultPart(result, options = {}) {
    return {
      functionResponse: {
        name: resultName(result),
        ...(options.preserveIds && result.id
          ? { id: getCall(result.id)?.providerId || result.id }
          : {}),
        response: result.error ? { error: result.text } : { content: result.text },
      },
    };
  }
  return {
    callText,
    resultText,
    callPart,
    resultPart,
    callParts: (call, options = {}) => [
      declared(safeName(call.name), options) ? callPart(call, options) : callText(call),
    ],
    resultParts(result, options = {}) {
      const media = result.mediaParts || [];
      if (result.orphan) return [resultText(result), ...media];
      const name = safeName(getCall(result.id)?.name || result.name || '');
      if (declared(name, options) || media.length) return [resultPart(result, options), ...media];
      return [resultText(result)];
    },
  };
}

module.exports = { createGeminiNativeToolHistory };
