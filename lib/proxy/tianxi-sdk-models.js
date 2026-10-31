'use strict';
// Authenticated Tianxi SDK catalog, refreshed 2026-10-29 (America/Los_Angeles).
const TIANXI_SDK_MODELS = Object.freeze(
  [
    ['auto', 'auto', 'Auto'],
    ['fast', 'fast', 'Fast'],
    ['qwen3.8-max', 'qmodel_38max', 'Qwen3.8-Max'],
    ['qwen3.8-flash', 'qfmodel', 'Qwen3.8-Flash'],
    ['qwen3.7-plus', 'qmodel', 'Qwen3.7-Plus'],
    ['deepseek-v4-pro', 'dmodel', 'DeepSeek-V4-Pro'],
    ['deepseek-flash', 'dfmodel', 'DeepSeek-Flash'],
    ['glm-5.3', 'gmodel', 'GLM-5.3'],
    ['glm-5.3-flash', 'gfmodel', 'GLM-5.3-Flash'],
    ['kimi-k3.1-pro', 'kmodel_latest', 'Kimi-K3.1-Pro'],
    ['kimi-k2.8-preview', 'kmodel', 'Kimi-K2.8-Preview'],
    ['minimax-m3.1-flash', 'mmodel', 'MiniMax-M3.1-Flash'],
  ].map(([alias, modelId, name]) => Object.freeze({ alias: `tianxi/${alias}`, modelId, name }))
);
function sdkModel(modelId) {
  return TIANXI_SDK_MODELS.find((m) => m.modelId === modelId) || null;
}
function supportsTianxiSdkClientTools(modelId) {
  return sdkModel(modelId) !== null;
}
function tianxiSdkRoutes() {
  const models = [
    ...TIANXI_SDK_MODELS,
    // Keep existing sessions routable while showing only current catalog names.
    { alias: 'tianxi/kimi-k3', modelId: 'kmodel_latest', name: 'Kimi-K3.1-Pro', legacy: true },
    { alias: 'tianxi/minimax-m2.7', modelId: 'mmodel', name: 'MiniMax-M3.1-Flash', legacy: true },
  ];
  return models.map((m) => ({
    from: m.alias,
    profileId: 'tianxi-official',
    to: m.modelId,
    group: 'tianxi',
    labelOverride: `Tianxi ${m.name}`,
    capabilities: supportsTianxiSdkClientTools(m.modelId) ? ['function-call'] : [],
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsStreaming: true,
    clientProtocols: ['openai-responses', 'claude'],
    tianxiSdkModel: m.modelId,
    ...(m.legacy ? { exposeInModels: false } : {}),
  }));
}
module.exports = { TIANXI_SDK_MODELS, sdkModel, tianxiSdkRoutes, supportsTianxiSdkClientTools };
