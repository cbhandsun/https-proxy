'use strict';

const {
  getAntigravityCliStatus,
  applyAntigravityCliProxy,
  restoreAntigravityCliProxy,
  getClaudeCodeStatus,
  applyClaudeCodeProxy,
  restoreClaudeCodeProxy,
  getCodexStatus,
  getCodexDesktopStatus,
  applyCodexProxy,
  restoreCodexProxy,
  getGeminiCliStatus,
  applyGeminiCliProxy,
  restoreGeminiCliProxy,
} = require('./tool-configs');
const { CONFIG_FILE, loadConfig, getModelRoutes, getProfiles } = require('./config');
const { writeJsonFileAtomically } = require('./management-utils');
const { localModelRoutesForClientProtocol } = require('./models');
const {
  getOpenCodeStatus,
  applyOpenCodeProxy,
  restoreOpenCodeProxy,
  getAiderStatus,
  applyAiderProxy,
  restoreAiderProxy,
} = require('./extra-agent-configs');

const PROVIDER_PRESETS_CATALOG = Object.freeze({
  'openai-official': {
    id: 'openai-official',
    name: 'OpenAI 官方',
    protocol: 'openai',
    targetUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.4',
    recommendedModels: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'o3'],
  },
  'claude-official': {
    id: 'claude-official',
    name: 'Anthropic Claude 官方',
    protocol: 'claude',
    targetUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-6',
    recommendedModels: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
  },
  'gemini-official': {
    id: 'gemini-official',
    name: 'Google Gemini 官方',
    protocol: 'gemini',
    targetUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-2.5-pro',
    recommendedModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-pro-preview'],
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek (OpenAI 协议)',
    protocol: 'openai',
    targetUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    recommendedModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  'deepseek-openai': {
    id: 'deepseek-openai',
    name: 'DeepSeek (OpenAI 协议)',
    protocol: 'openai',
    targetUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    recommendedModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  'deepseek-anthropic': {
    id: 'deepseek-anthropic',
    name: 'DeepSeek (Anthropic 协议)',
    protocol: 'claude',
    targetUrl: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-chat',
    recommendedModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  moonshot: {
    id: 'moonshot',
    name: 'Kimi / Moonshot (OpenAI 协议)',
    protocol: 'openai',
    targetUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2-0905-preview',
    recommendedModels: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview', 'kimi-thinking-preview'],
  },
  'kimi-coding-anthropic': {
    id: 'kimi-coding-anthropic',
    name: 'Kimi For Coding (Anthropic 协议)',
    protocol: 'claude',
    targetUrl: 'https://api.kimi.com/coding',
    defaultModel: 'kimi-for-coding',
    recommendedModels: ['kimi-for-coding', 'kimi-k2-0905-preview'],
  },
  'glm-coding': {
    id: 'glm-coding',
    name: '智谱 GLM Coding Plan (OpenAI 协议)',
    protocol: 'openai',
    targetUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    defaultModel: 'glm-5.1',
    recommendedModels: ['glm-5.1', 'glm-4.7', 'glm-4.5-air'],
  },
  'glm-coding-openai': {
    id: 'glm-coding-openai',
    name: '智谱 GLM Coding Plan (OpenAI 协议)',
    protocol: 'openai',
    targetUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    defaultModel: 'glm-5.1',
    recommendedModels: ['glm-5.1', 'glm-4.7', 'glm-4.5-air'],
  },
  'glm-coding-anthropic': {
    id: 'glm-coding-anthropic',
    name: '智谱 GLM Coding Plan (Anthropic 协议)',
    protocol: 'claude',
    targetUrl: 'https://open.bigmodel.cn/api/anthropic',
    defaultModel: 'glm-5.1',
    recommendedModels: ['glm-5.1', 'glm-4.7', 'glm-4.5-air'],
  },
  'dashscope-openai': {
    id: 'dashscope-openai',
    name: '阿里百炼 Qwen (OpenAI 协议)',
    protocol: 'openai',
    targetUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3-coder-plus',
    recommendedModels: ['qwen3-coder-plus', 'qwen-max-latest', 'qwq-plus'],
  },
  'dashscope-anthropic': {
    id: 'dashscope-anthropic',
    name: '阿里百炼 Qwen (Anthropic 协议)',
    protocol: 'claude',
    targetUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    defaultModel: 'qwen3-coder-plus',
    recommendedModels: ['qwen3-coder-plus', 'qwen-max-latest'],
  },
  minimax: {
    id: 'minimax',
    name: 'MiniMax (OpenAI 协议)',
    protocol: 'openai',
    targetUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-M2.7',
    recommendedModels: ['MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-Text-01'],
  },
  'minimax-openai': {
    id: 'minimax-openai',
    name: 'MiniMax (OpenAI 协议)',
    protocol: 'openai',
    targetUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-M2.7',
    recommendedModels: ['MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-Text-01'],
  },
  'minimax-anthropic': {
    id: 'minimax-anthropic',
    name: 'MiniMax (Anthropic 协议)',
    protocol: 'claude',
    targetUrl: 'https://api.minimaxi.com/anthropic',
    defaultModel: 'MiniMax-M2.7',
    recommendedModels: ['MiniMax-M2.7', 'MiniMax-M2.5'],
  },
  siliconflow: {
    id: 'siliconflow',
    name: 'SiliconFlow 硅基流动',
    protocol: 'openai',
    targetUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    recommendedModels: [
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen3-Coder-480B-A35B-Instruct',
    ],
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai',
    targetUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4.6',
    recommendedModels: [
      'anthropic/claude-sonnet-4.6',
      'openai/gpt-5.4',
      'deepseek/deepseek-r1',
      'google/gemini-2.5-pro',
    ],
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama (本地模型)',
    protocol: 'openai',
    targetUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5-coder:32b',
    recommendedModels: ['qwen2.5-coder:32b', 'deepseek-r1:32b', 'glm4:9b'],
  },
});

const AGENT_DEFINITIONS = Object.freeze({
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    clientProtocol: 'claude',
  },
  codex: {
    id: 'codex',
    name: 'Codex CLI',
    clientProtocol: 'openai-responses',
  },
  'codex-desktop': {
    id: 'codex-desktop',
    name: 'Codex Desktop',
    clientProtocol: 'openai-responses',
  },
  'antigravity-cli': {
    id: 'antigravity-cli',
    name: 'Antigravity CLI',
    clientProtocol: 'claude',
  },
  'gemini-cli': {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    clientProtocol: 'openai-chat',
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    clientProtocol: 'openai-chat',
  },
  aider: {
    id: 'aider',
    name: 'Aider',
    clientProtocol: 'openai-chat',
  },
});

function normalizeAgentId(rawAgent) {
  const key = String(rawAgent || '')
    .trim()
    .toLowerCase();
  if (key === 'claude' || key === 'claudecode' || key === 'claude-code') return 'claude-code';
  if (key === 'codex' || key === 'codex-cli') return 'codex';
  if (key === 'codex-desktop' || key === 'codexdesktop') return 'codex-desktop';
  if (key === 'antigravity' || key === 'antigravity-cli' || key === 'agy') return 'antigravity-cli';
  if (key === 'gemini' || key === 'gemini-cli') return 'gemini-cli';
  if (key === 'opencode' || key === 'open-code') return 'opencode';
  if (key === 'aider' || key === 'aider-cli') return 'aider';
  return '';
}

function findMatchingRouteForModel(model, modelRoutes) {
  const target = String(model || '').trim();
  if (!target || !Array.isArray(modelRoutes)) return null;
  return (
    modelRoutes.find(
      (route) => route && route.enabled !== false && String(route.from || '').trim() === target
    ) || null
  );
}

function getAgentBindingsStatus(config = null) {
  const activeConfig = config || loadConfig();
  const routes = getModelRoutes(activeConfig);
  const profiles = getProfiles(activeConfig);
  const findProfileName = (profileId) => {
    const found = profiles.find((p) => p && p.id === profileId);
    return found ? found.name || found.id : profileId || '';
  };

  const claudeCode = getClaudeCodeStatus();
  const codex = getCodexStatus('cli');
  const codexDesktop = getCodexDesktopStatus();
  const antigravity = getAntigravityCliStatus();
  const gemini = getGeminiCliStatus();
  const opencode = getOpenCodeStatus();
  const aider = getAiderStatus();

  const enrich = (id, status, baseUrlField = 'baseUrl') => {
    const model = String(status.model || '').trim();
    const matchedRoute = findMatchingRouteForModel(model, routes);
    const baseUrl = String(status[baseUrlField] || '').trim();
    return {
      agent: id,
      name: AGENT_DEFINITIONS[id].name,
      proxyActive: Boolean(baseUrl && baseUrl.includes('localhost')),
      baseUrl,
      model,
      profileId: matchedRoute ? matchedRoute.profileId : '',
      profileName: matchedRoute ? findProfileName(matchedRoute.profileId) : '',
      targetModel: matchedRoute ? matchedRoute.to || model : model,
      fastModel: String(status.fastModel || '').trim(),
      configPath: status.configPath || '',
    };
  };

  return {
    agents: [
      enrich('claude-code', claudeCode),
      enrich('codex', codex),
      enrich('codex-desktop', codexDesktop),
      enrich('antigravity-cli', antigravity),
      enrich('gemini-cli', gemini, 'envBaseUrl'),
      enrich('opencode', opencode),
      enrich('aider', aider),
    ],
    presets: PROVIDER_PRESETS_CATALOG,
  };
}

function bindAgentToModel(options = {}, deps = {}) {
  const agentId = normalizeAgentId(options.agent);
  if (!agentId || !AGENT_DEFINITIONS[agentId]) {
    const err = new Error(
      `Unsupported agent "${options.agent || ''}". Supported: claude-code, codex, codex-desktop, antigravity-cli, gemini-cli, opencode, aider`
    );
    err.statusCode = 400;
    throw err;
  }
  if (String(options.action || '').trim().toLowerCase() === 'restore') {
    const restoreTools = deps.toolConfigs || {
      restoreClaudeCodeProxy,
      restoreCodexProxy,
      restoreAntigravityCliProxy,
      restoreGeminiCliProxy,
      restoreOpenCodeProxy,
      restoreAiderProxy,
    };
    let restoreResult = {};
    if (agentId === 'claude-code') restoreResult = restoreTools.restoreClaudeCodeProxy() || {};
    else if (agentId === 'codex' || agentId === 'codex-desktop')
      restoreResult = restoreTools.restoreCodexProxy() || {};
    else if (agentId === 'antigravity-cli')
      restoreResult = restoreTools.restoreAntigravityCliProxy() || {};
    else if (agentId === 'gemini-cli') restoreResult = restoreTools.restoreGeminiCliProxy() || {};
    else if (agentId === 'opencode') restoreResult = restoreTools.restoreOpenCodeProxy() || {};
    else if (agentId === 'aider') restoreResult = restoreTools.restoreAiderProxy() || {};
    return {
      agent: agentId,
      restored: true,
      restoreResult,
    };
  }
  const targetModel = String(options.model || '').trim();
  if (!targetModel) {
    const err = new Error('model is required');
    err.statusCode = 400;
    throw err;
  }
  const clientModel = String(options.clientModel || targetModel).trim();
  const readConfig = typeof deps.loadConfig === 'function' ? deps.loadConfig : loadConfig;
  const writeConfig =
    typeof deps.writeConfig === 'function'
      ? deps.writeConfig
      : (nextConfig) => writeJsonFileAtomically(CONFIG_FILE, nextConfig);
  const reloadConfig =
    typeof deps.reloadProxyConfig === 'function' ? deps.reloadProxyConfig : null;

  const config = readConfig();
  const profiles = Array.isArray(config.profiles) ? config.profiles : [];
  const profileId = String(options.profileId || config.activeProfile || '').trim();
  const profile = profiles.find((item) => item && item.id === profileId);
  if (!profile) {
    const err = new Error(`Profile "${profileId}" does not exist`);
    err.statusCode = 400;
    throw err;
  }

  const agentDef = AGENT_DEFINITIONS[agentId];
  const modelRoutes = Array.isArray(config.modelRoutes) ? [...config.modelRoutes] : [];
  const existingIdx = modelRoutes.findIndex(
    (route) => route && String(route.from || '').trim() === clientModel
  );
  let routeUpdated = false;
  if (existingIdx >= 0) {
    const existing = modelRoutes[existingIdx];
    const existingProtocols = Array.isArray(existing.clientProtocols)
      ? existing.clientProtocols
      : [];
    const nextProtocols =
      existingProtocols.length === 0 || existingProtocols.includes(agentDef.clientProtocol)
        ? existingProtocols
        : [...existingProtocols, agentDef.clientProtocol];
    modelRoutes[existingIdx] = {
      ...existing,
      from: clientModel,
      profileId: profile.id,
      to: targetModel,
      enabled: true,
      ...(nextProtocols.length > 0 ? { clientProtocols: nextProtocols } : {}),
    };
    routeUpdated = true;
  } else {
    modelRoutes.unshift({
      from: clientModel,
      profileId: profile.id,
      to: targetModel,
      enabled: true,
      clientProtocols: ['claude', 'openai-chat', 'openai-responses'],
    });
    routeUpdated = true;
  }

  const fastModel = typeof options.fastModel === 'string' ? options.fastModel.trim() : '';
  if (fastModel) {
    const fastIdx = modelRoutes.findIndex((route) => route && String(route.from || '').trim() === fastModel);
    if (fastIdx >= 0) {
      modelRoutes[fastIdx] = {
        ...modelRoutes[fastIdx],
        from: fastModel,
        profileId: profile.id,
        to: fastModel,
        enabled: true,
      };
    } else {
      modelRoutes.push({
        from: fastModel,
        profileId: profile.id,
        to: fastModel,
        enabled: true,
        clientProtocols: ['claude', 'openai-chat', 'openai-responses'],
      });
    }
    routeUpdated = true;
  }

  if (routeUpdated) {
    const nextConfig = {
      ...config,
      modelRoutes,
    };
    writeConfig(nextConfig);
    if (reloadConfig) {
      try {
        reloadConfig();
      } catch (_err) {}
    }
  }

  const applyTools = deps.toolConfigs || {
    applyClaudeCodeProxy,
    applyCodexProxy,
    applyAntigravityCliProxy,
    applyGeminiCliProxy,
    applyOpenCodeProxy,
    applyAiderProxy,
  };

  let applyResult = {};
  if (agentId === 'claude-code') {
    applyResult = applyTools.applyClaudeCodeProxy({ model: clientModel, ...(options.fastModel !== undefined ? { fastModel } : {}) }) || {};
  } else if (agentId === 'codex' || agentId === 'codex-desktop') {
    const codexRoutes = localModelRoutesForClientProtocol(modelRoutes, 'openai-responses');
    applyResult =
      applyTools.applyCodexProxy({
        model: clientModel,
        reasoningEffort: options.reasoningEffort,
        modelRoutes: codexRoutes,
      }) || {};
  } else if (agentId === 'antigravity-cli') {
    applyResult = applyTools.applyAntigravityCliProxy({ model: clientModel }) || {};
  } else if (agentId === 'gemini-cli') {
    applyResult = applyTools.applyGeminiCliProxy({ model: clientModel }) || {};
  } else if (agentId === 'opencode') {
    applyResult = applyTools.applyOpenCodeProxy({ model: clientModel }) || {};
  } else if (agentId === 'aider') {
    applyResult = applyTools.applyAiderProxy({ model: clientModel, ...(options.fastModel !== undefined ? { fastModel } : {}) }) || {};
  }

  return {
    agent: agentId,
    profileId: profile.id,
    profileName: profile.name || profile.id,
    model: clientModel,
    targetModel,
    ...(fastModel ? { fastModel } : {}),
    routeUpdated,
    applyResult,
  };
}

module.exports = {
  PROVIDER_PRESETS_CATALOG,
  AGENT_DEFINITIONS,
  normalizeAgentId,
  getAgentBindingsStatus,
  bindAgentToModel,
};
