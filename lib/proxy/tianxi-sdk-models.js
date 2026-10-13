'use strict';
// Verified against the installed Tianxi live catalog and real generation.
const TIANXI_SDK_MODELS = Object.freeze(
  [
    ['auto', 'auto', 'Auto'],
    ['qwen3.8-max', 'qmodel_38max', 'Qwen3.8-Max'],
    ['qwen3.8-flash', 'qfmodel', 'Qwen3.8-Flash'],
    ['qwen3.7-max', 'qmodel_latest', 'Qwen3.7-Max'],
    ['qwen3.7-plus', 'qmodel', 'Qwen3.7-Plus'],
    ['qwen3.7-flash', 'q37fmodel', 'Qwen3.7-Flash'],
    ['deepseek-v4-pro', 'dmodel', 'DeepSeek-V4-Pro'],
    ['deepseek-flash', 'dfmodel', 'DeepSeek-Flash'],
    ['glm-5.3', 'gmodel', 'GLM-5.3'],
    ['glm-5.3-flash', 'gfmodel', 'GLM-5.3-Flash'],
    ['glm-5.2', 'gm51model', 'GLM-5.2'],
    ['kimi-k3', 'kmodel_latest', 'Kimi-K3'],
    ['kimi-k2.8-preview', 'kmodel', 'Kimi-K2.8-Preview'],
    ['minimax-m2.7', 'mmodel', 'MiniMax-M2.7'],
  ].map(([alias, modelId, name]) => Object.freeze({ alias: `tianxi/${alias}`, modelId, name }))
);
function sdkModel(modelId) {
  return TIANXI_SDK_MODELS.find((m) => m.modelId === modelId) || null;
}
function tianxiSdkRoutes() {
  return TIANXI_SDK_MODELS.map((m) => ({
    from: m.alias,
    profileId: 'tianxi-official',
    to: m.modelId,
    group: 'tianxi',
    labelOverride: `Tianxi ${m.name}`,
    capabilities: [],
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsStreaming: true,
    clientProtocols: ['openai-responses'],
    tianxiSdkModel: m.modelId,
  }));
}
module.exports = { TIANXI_SDK_MODELS, sdkModel, tianxiSdkRoutes };
