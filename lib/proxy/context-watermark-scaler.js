'use strict';

const DEFAULT_RESTRICTED_THIRD_PARTY_TOKENS = 128_000;
const DEFAULT_WORKBUDDY_OPERATIONAL_TOKENS = 96 * 1024;
const ONE_MILLION_WINDOW_TOKENS = 1_000_000;
const DEFAULT_FRONTIER_CLIENT_WINDOW_TOKENS = 200_000;

function positiveInt(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

function inferUpstreamContextWindowTokens(arg1 = {}, arg2 = null, arg3 = null, arg4 = null) {
  const isPositional = typeof arg1 === 'string' || arg2 !== null || arg3 !== null || arg4 !== null;
  const {
    targetModel = '',
    profile = null,
    route = null,
    protocolOptions = null,
  } = isPositional
    ? {
        targetModel: typeof arg1 === 'string' ? arg1 : '',
        profile: arg2,
        route: arg3,
        protocolOptions: arg4,
      }
    : arg1 || {};
  const explicit =
    positiveInt(route?.maxContextTokens) ||
    positiveInt(profile?.maxContextTokens) ||
    positiveInt(protocolOptions?.maxContextTokens);
  if (explicit >= 4096) return explicit;

  const modelLower = String(targetModel || route?.to || '').toLowerCase();
  const profileIdLower = String(profile?.id || '').toLowerCase();
  const targetUrlLower = String(profile?.targetUrl || '').toLowerCase();
  const protocolLower = String(profile?.protocol || '').toLowerCase();

  if (protocolLower === 'workbuddy' || profileIdLower.includes('workbuddy')) {
    return (
      positiveInt(protocolOptions?.workbuddyOperationalInputTokens) ||
      DEFAULT_WORKBUDDY_OPERATIONAL_TOKENS
    );
  }
  if (
    modelLower.includes('deepseek') ||
    profileIdLower.includes('deepseek') ||
    targetUrlLower.includes('deepseek.com')
  ) {
    return DEFAULT_RESTRICTED_THIRD_PARTY_TOKENS;
  }
  if (
    modelLower.includes('glm') ||
    profileIdLower.includes('glm') ||
    targetUrlLower.includes('bigmodel.cn')
  ) {
    return DEFAULT_RESTRICTED_THIRD_PARTY_TOKENS;
  }
  if (
    modelLower.includes('minimax') ||
    profileIdLower.includes('minimax') ||
    targetUrlLower.includes('minimaxi.com')
  ) {
    return DEFAULT_RESTRICTED_THIRD_PARTY_TOKENS;
  }
  if (protocolLower === 'tianxi' || modelLower.startsWith('tianxi/')) {
    return DEFAULT_RESTRICTED_THIRD_PARTY_TOKENS;
  }
  return 0;
}

function inferClientAdvertisedWindowTokens({
  clientModel = '',
  requestModel = '',
  route = null,
  claudeDesktopModel = null,
  profile = null,
  protocolOptions = null,
} = {}) {
  const explicit =
    positiveInt(route?.clientContextTokens) ||
    positiveInt(claudeDesktopModel?.clientContextTokens) ||
    positiveInt(profile?.clientAdvertisedContextTokens) ||
    positiveInt(protocolOptions?.clientContextTokens);
  if (explicit >= 8192) return explicit;

  const modelStr = String(clientModel || requestModel || route?.from || '');
  if (
    route?.supports1m === true ||
    claudeDesktopModel?.supports1m === true ||
    /(?:^|[-_[\s])1m(?:[-_\]\s]|$)/i.test(modelStr)
  ) {
    return ONE_MILLION_WINDOW_TOKENS;
  }

  const adaptiveExplicit =
    route?.adaptiveCompactionWatermark === true ||
    profile?.adaptiveCompactionWatermark === true ||
    protocolOptions?.compactionWatermarkPolicy === 'auto' ||
    protocolOptions?.compactionWatermarkPolicy === 'adaptive';
  if (adaptiveExplicit && /^(?:claude-|gpt-5|gpt-6|codex\/|o3|o4)/i.test(modelStr.trim())) {
    return DEFAULT_FRONTIER_CLIENT_WINDOW_TOKENS;
  }
  return 0;
}

function scaleTokensForCompactionWatermark(rawInputTokens, context = {}) {
  const baseTokens = Math.max(1, positiveInt(rawInputTokens) || 1);
  const { protocolOptions, profile, route } = context || {};
  if (
    protocolOptions?.compactionWatermarkPolicy === 'disabled' ||
    profile?.adaptiveCompactionWatermark === false ||
    route?.adaptiveCompactionWatermark === false
  ) {
    return {
      inputTokens: baseTokens,
      scaledTokens: baseTokens,
      rawInputTokens: baseTokens,
      rawTokens: baseTokens,
      scaled: false,
      applied: false,
      scaleFactor: 1,
      clientWindowTokens: 0,
      upstreamWindowTokens: 0,
    };
  }

  const upstreamWindowTokens = inferUpstreamContextWindowTokens(context);
  const clientWindowTokens = inferClientAdvertisedWindowTokens(context);
  if (
    !upstreamWindowTokens ||
    !clientWindowTokens ||
    clientWindowTokens <= upstreamWindowTokens ||
    upstreamWindowTokens < 4096
  ) {
    return {
      inputTokens: baseTokens,
      scaledTokens: baseTokens,
      rawInputTokens: baseTokens,
      rawTokens: baseTokens,
      scaled: false,
      applied: false,
      scaleFactor: 1,
      clientWindowTokens,
      upstreamWindowTokens,
    };
  }

  const rawRatio = clientWindowTokens / upstreamWindowTokens;
  const scaleFactor = Math.min(16, Math.max(1, rawRatio));
  const scaledTokens = Math.min(
    clientWindowTokens,
    Math.max(baseTokens, Math.ceil(baseTokens * scaleFactor))
  );
  const isScaled = scaledTokens !== baseTokens;
  return {
    inputTokens: scaledTokens,
    scaledTokens,
    rawInputTokens: baseTokens,
    rawTokens: baseTokens,
    scaled: isScaled,
    applied: isScaled,
    scaleFactor: Number(scaleFactor.toFixed(4)),
    clientWindowTokens,
    upstreamWindowTokens,
  };
}

module.exports = {
  DEFAULT_RESTRICTED_THIRD_PARTY_TOKENS,
  DEFAULT_WORKBUDDY_OPERATIONAL_TOKENS,
  ONE_MILLION_WINDOW_TOKENS,
  DEFAULT_FRONTIER_CLIENT_WINDOW_TOKENS,
  inferUpstreamContextWindowTokens,
  inferClientAdvertisedWindowTokens,
  scaleTokensForCompactionWatermark,
};
