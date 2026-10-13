'use strict';
const { prepareDeepSeekClaudeReasoning } = require('../deepseek-request-contract');
const { applyDeepSeekClaudeReasoning } = require('../deepseek-claude-reasoning');
const { prepareResponsesClaudeRequest } = require('../responses-claude-request');
const { optimizeContextMessages } = require('../context-optimizer');
const { rejectContextOverflow } = require('../context-budget-manager');
const { attachPreparedDiagnostics } = require('./client-diagnostics');
const {
  applyAnthropicContextManagement,
  isNativeAnthropicMessagesTarget,
} = require('../anthropic-context-management');

function prepareOpenAIClaudeRequest(ctx, clientRes, prepared, shape, target) {
  const original = ctx.parseProxyBody(clientRes, prepared.buffer);
  if (!original) return null;
  const reasoningPlan = prepareDeepSeekClaudeReasoning(prepared, original);
  const parsed = reasoningPlan?.source || original;
  const targetModel =
    prepared.rewriteTo !== '-' ? prepared.rewriteTo : parsed.model || 'claude-sonnet-4-6';
  const responses = shape === 'responses';
  const reject = responses
    ? ctx.rejectUnsupportedResponsesNonOpenAIConversion
    : ctx.rejectUnsupportedOpenAIChatNonOpenAIConversion;
  if (reject(clientRes, parsed, 'Claude', targetModel)) return null;
  const native =
    responses &&
    typeof ctx.resolveResponsesHistory === 'function' &&
    typeof ctx.responsesHistoryToClaude === 'function' &&
    typeof ctx.claudeResponseToResponses === 'function';
  const nativeContextManagement = isNativeAnthropicMessagesTarget(prepared.profile, target);
  const preparedNative = native
    ? prepareResponsesClaudeRequest(ctx, clientRes, parsed, targetModel, {
        nativeContextManagement,
      })
    : null;
  const chatBody = responses
    ? native
      ? preparedNative?.context
      : ctx.responsesToChatWithHistory(clientRes, parsed, targetModel)
    : parsed;
  if (!chatBody) return null;
  if (responses && !nativeContextManagement && Array.isArray(chatBody.messages)) {
    const { messages } = optimizeContextMessages(chatBody.messages);
    chatBody.messages = messages;
  }
  const claudeBody = native
    ? preparedNative.request
    : ctx.openAIChatToClaudeMessages(chatBody, targetModel, { nativeContextManagement });
  applyDeepSeekClaudeReasoning(claudeBody, reasoningPlan);
  const contextManagement = applyAnthropicContextManagement(claudeBody, {
    profile: prepared.profile,
    target,
    policy: ctx.protocolOptions?.anthropicContextManagementPolicy,
    compactionTrigger: ctx.protocolOptions?.anthropicCompactionTrigger,
  });
  if (claudeBody.__hpmDiagnostics && typeof claudeBody.__hpmDiagnostics === 'object') {
    claudeBody.__hpmDiagnostics.providerContext = {
      applied: contextManagement.applied === true,
      explicit: contextManagement.explicit === true,
      reason: contextManagement.reason,
    };
  }
  if (rejectContextOverflow(clientRes, claudeBody, ctx.sendJsonError)) return null;
  attachPreparedDiagnostics(
    clientRes,
    prepared,
    responses ? '/responses' : '/chat/completions',
    claudeBody,
    {
      protocol: 'claude',
      target: targetModel,
      entryProtocol: responses ? 'responses' : 'chat',
    }
  );
  return { parsed, targetModel, native, chatBody, claudeBody, contextManagement };
}
module.exports = { prepareOpenAIClaudeRequest };
