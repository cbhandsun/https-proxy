const DEFAULT_MODEL_BY_PRESET_HINT = [
  { match: /kimi\.com\/coding/i, model: 'kimi-for-coding', fastModel: 'kimi-for-coding' },
  { match: /moonshot\.cn/i, model: 'kimi-k2-0905-preview', fastModel: 'kimi-k2-turbo-preview' },
  { match: /deepseek\.com/i, model: 'deepseek-chat', fastModel: 'deepseek-chat' },
  { match: /bigmodel\.cn/i, model: 'glm-5.1', fastModel: 'glm-4.5-air' },
  { match: /dashscope\.aliyuncs\.com/i, model: 'qwen3-coder-plus', fastModel: 'qwen-turbo-latest' },
  { match: /minimaxi\.com/i, model: 'MiniMax-M2.7', fastModel: 'MiniMax-M2.5' },
  { match: /siliconflow\.cn/i, model: 'deepseek-ai/DeepSeek-V3', fastModel: 'Qwen/Qwen2.5-Coder-32B-Instruct' },
  { match: /openrouter\.ai/i, model: 'anthropic/claude-sonnet-4.6', fastModel: 'anthropic/claude-haiku-4.5' },
  { match: /11434/i, model: 'qwen2.5-coder:32b', fastModel: 'qwen2.5-coder:7b' },
  { match: /anthropic\.com/i, model: 'claude-sonnet-4-6', fastModel: 'claude-haiku-4-5' },
  { match: /googleapis\.com/i, model: 'gemini-2.5-pro', fastModel: 'gemini-2.5-flash' },
  { match: /openai\.com/i, model: 'gpt-5.4', fastModel: 'gpt-5.4-mini' },
];

const QUICK_PRESET_DEFINITIONS = {
  'kimi-coding-anthropic': {
    id: 'kimi-coding',
    name: 'Kimi For Coding',
    protocol: 'claude',
    targetUrl: 'https://api.kimi.com/coding',
    defaultModel: 'kimi-for-coding',
  },
  'deepseek-openai': {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    protocol: 'openai',
    targetUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
  },
  'glm-coding-openai': {
    id: 'glm-coding',
    name: '智谱 GLM Coding',
    protocol: 'openai',
    targetUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    defaultModel: 'glm-5.1',
  },
  'dashscope-openai': {
    id: 'dashscope-qwen',
    name: '阿里百炼 Qwen',
    protocol: 'openai',
    targetUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3-coder-plus',
  },
  siliconflow: {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    protocol: 'openai',
    targetUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
  },
  'minimax-openai': {
    id: 'minimax',
    name: 'MiniMax 官方',
    protocol: 'openai',
    targetUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-M2.7',
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai',
    targetUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4.6',
  },
  ollama: {
    id: 'ollama-local',
    name: 'Ollama 本地模型',
    protocol: 'openai',
    targetUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5-coder:32b',
  },
};

const DISPLAY_AGENTS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    desc: 'Anthropic CLI 编程智能体',
    supportsFastModel: true,
    fastLabel: '轻量副模型 (SMALL_FAST)',
  },
  { id: 'codex', name: 'Codex CLI', desc: 'OpenAI Codex 终端助手' },
  { id: 'opencode', name: 'OpenCode', desc: '开源终端 AI 编程助手' },
  {
    id: 'aider',
    name: 'Aider',
    desc: 'Git 结对编程终端 Agent',
    supportsFastModel: true,
    fastLabel: '轻量副模型 (weak-model)',
  },
  { id: 'antigravity-cli', name: 'Antigravity CLI', desc: 'Antigravity 智能编程终端' },
  { id: 'gemini-cli', name: 'Gemini CLI', desc: 'Google Gemini 终端助手' },
];

function inferDefaultModelForProfile(profile) {
  if (!profile) return 'claude-sonnet-4-6';
  const url = String(profile.targetUrl || '');
  for (const entry of DEFAULT_MODEL_BY_PRESET_HINT) {
    if (entry.match.test(url)) return entry.model;
  }
  if (profile.protocol === 'claude') return 'claude-sonnet-4-6';
  if (profile.protocol === 'gemini') return 'gemini-2.5-pro';
  return 'gpt-5.4';
}

function inferFastModelForProfile(profile) {
  if (!profile) return '';
  const url = String(profile.targetUrl || '');
  for (const entry of DEFAULT_MODEL_BY_PRESET_HINT) {
    if (entry.match.test(url)) return entry.fastModel || '';
  }
  if (profile.protocol === 'claude') return 'claude-haiku-4-5';
  if (profile.protocol === 'gemini') return 'gemini-2.5-flash';
  return 'gpt-5.4-mini';
}

export function createAgentHubController(deps) {
  let latestAgentStatuses = {};
  let latestCooldowns = [];
  let isRefreshing = false;

  async function refreshCooldownsStatus() {
    if (!window.proxyManager?.cooldownsStatus) return;
    try {
      const res = await window.proxyManager.cooldownsStatus();
      if (res && res.ok && Array.isArray(res.cooldowns)) {
        latestCooldowns = res.cooldowns;
        renderCooldownBanner();
      }
    } catch (_err) {}
  }

  function renderCooldownBanner() {
    const banner = deps.$('overviewCooldownBanner');
    if (!banner) return;
    if (!Array.isArray(latestCooldowns) || latestCooldowns.length === 0) {
      banner.style.display = 'none';
      banner.replaceChildren();
      return;
    }
    banner.style.display = 'flex';
    const left = document.createElement('div');
    left.style.cssText = 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px;';
    const title = document.createElement('strong');
    title.style.color = '#d97706';
    title.textContent = `⏳ 节点限流冷却中 (${latestCooldowns.length})：`;
    left.appendChild(title);

    for (const item of latestCooldowns.slice(0, 6)) {
      const tag = document.createElement('span');
      tag.className = 'badge';
      tag.style.cssText = 'background: rgba(245, 158, 11, 0.2); color: #b45309; font-size: 11.5px;';
      tag.textContent = `${item.profileId} / ${item.model} (${item.retryAfterSeconds}s)`;
      left.appendChild(tag);
    }

    const clearBtn = document.createElement('button');
    clearBtn.className = 'secondary';
    clearBtn.style.cssText = 'margin: 0; padding: 3px 10px; font-size: 11.5px; min-height: 26px;';
    clearBtn.textContent = '⚡ 一键解除全部冷却';
    clearBtn.onclick = async () => {
      clearBtn.disabled = true;
      try {
        const res = await window.proxyManager.clearCooldowns({});
        if (res && res.ok) {
          deps.showToast(`已解除 ${res.cleared || 0} 个冷却节点`, 'success');
          latestCooldowns = [];
          renderCooldownBanner();
        }
      } finally {
        clearBtn.disabled = false;
      }
    };

    banner.replaceChildren(left, clearBtn);
  }

  async function refreshAgentHubStatus() {
    if (isRefreshing || !window.proxyManager?.agentBindingsStatus) return;
    isRefreshing = true;
    try {
      await refreshCooldownsStatus();
      const res = await window.proxyManager.agentBindingsStatus();
      if (res && res.ok && Array.isArray(res.agents)) {
        const nextMap = {};
        for (const item of res.agents) {
          if (item && item.agent) nextMap[item.agent] = item;
        }
        latestAgentStatuses = nextMap;
        const opencodeBadge = deps.$('toolBadge-opencode');
        if (opencodeBadge) {
          opencodeBadge.textContent = nextMap.opencode?.proxyActive ? '代理运行中' : '未接管';
          opencodeBadge.className = nextMap.opencode?.proxyActive ? 'badge active' : 'badge';
        }
        const aiderBadge = deps.$('toolBadge-aider');
        if (aiderBadge) {
          aiderBadge.textContent = nextMap.aider?.proxyActive ? '代理运行中' : '未接管';
          aiderBadge.className = nextMap.aider?.proxyActive ? 'badge active' : 'badge';
        }
        renderAgentHub();
      }
    } catch (_err) {
      // Ignore transient startup errors before proxy management port is ready
    } finally {
      isRefreshing = false;
    }
  }

  function renderAgentHub() {
    const container = deps.$('overviewAgentHubGrid');
    if (!container) return;
    const cfg = deps.getConfig();
    const profiles = cfg && Array.isArray(cfg.profiles) ? cfg.profiles : [];
    const activeProfileId = (cfg && cfg.activeProfile) || (profiles[0] && profiles[0].id) || '';

    container.replaceChildren(
      ...DISPLAY_AGENTS.map((agentMeta) => {
        const status = latestAgentStatuses[agentMeta.id] || {};
        const isProxyActive = Boolean(status.proxyActive);
        const currentProfileId = status.profileId || activeProfileId;
        const selectedProfileObj =
          profiles.find((p) => p && p.id === currentProfileId) || profiles[0] || null;
        const currentModel =
          status.model || inferDefaultModelForProfile(selectedProfileObj);
        const currentFastModel = status.fastModel || '';

        const card = document.createElement('div');
        card.className = 'agent-hub-card';
        card.style.cssText =
          'border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px; background: var(--card-highlight); display: flex; flex-direction: column; gap: 8px;';

        const head = document.createElement('div');
        head.style.cssText =
          'display: flex; align-items: center; justify-content: space-between; gap: 8px;';

        const titleWrap = document.createElement('div');
        const title = document.createElement('strong');
        title.style.fontSize = '13.5px';
        title.textContent = agentMeta.name;
        const subtitle = document.createElement('div');
        subtitle.className = 'muted';
        subtitle.style.fontSize = '11.5px';
        const fastSuffix = status.fastModel ? ` · 副模型: ${status.fastModel}` : '';
        subtitle.textContent = isProxyActive
          ? `当前: ${status.model || '默认'} → ${status.profileName || status.profileId || '默认上游'}${fastSuffix}`
          : agentMeta.desc;
        titleWrap.append(title, subtitle);

        const badge = document.createElement('span');
        badge.className = isProxyActive ? 'badge active' : 'badge';
        badge.textContent = isProxyActive ? '🟢 已接管' : '⚪ 直连/未接管';
        head.append(titleWrap, badge);

        const controls = document.createElement('div');
        controls.style.cssText =
          'display: grid; grid-template-columns: 1fr 1fr; gap: 6px; align-items: center;';

        const profileSelect = document.createElement('select');
        profileSelect.title = '选择目标上游服务商';
        profileSelect.style.cssText = 'font-size: 12px; min-height: 30px; padding: 4px 8px;';
        for (const p of profiles) {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = `${p.name || p.id} (${p.protocol})`;
          profileSelect.appendChild(opt);
        }
        if (currentProfileId) profileSelect.value = currentProfileId;

        const modelInput = document.createElement('input');
        modelInput.type = 'text';
        modelInput.setAttribute('list', 'availableModels');
        modelInput.placeholder = '主力模型名，如 kimi-for-coding';
        modelInput.value = currentModel;
        modelInput.style.cssText = 'font-size: 12px; min-height: 30px; padding: 4px 8px;';

        let fastModelInput = null;
        if (agentMeta.supportsFastModel) {
          fastModelInput = document.createElement('input');
          fastModelInput.type = 'text';
          fastModelInput.setAttribute('list', 'availableModels');
          fastModelInput.placeholder = `${agentMeta.fastLabel} (可选，如 glm-4.5-air / haiku)`;
          fastModelInput.value = currentFastModel;
          fastModelInput.style.cssText =
            'grid-column: 1 / -1; font-size: 11.5px; min-height: 28px; padding: 3px 8px;';
        }

        profileSelect.onchange = () => {
          const chosen = profiles.find((p) => p && p.id === profileSelect.value);
          if (chosen) {
            modelInput.value = inferDefaultModelForProfile(chosen);
            if (fastModelInput && !fastModelInput.value.trim()) {
              fastModelInput.value = inferFastModelForProfile(chosen);
            }
          }
        };

        controls.append(profileSelect, modelInput);
        if (fastModelInput) controls.appendChild(fastModelInput);

        const actions = document.createElement('div');
        actions.style.cssText = 'display: flex; gap: 6px; justify-content: flex-end;';

        const bindBtn = document.createElement('button');
        bindBtn.className = 'secondary';
        bindBtn.style.cssText = 'margin: 0; padding: 4px 10px; font-size: 12px; min-height: 28px;';
        bindBtn.textContent = isProxyActive ? '切换模型/上游' : '一键绑定代理';
        bindBtn.onclick = async () => {
          const targetProfileId = profileSelect.value;
          const targetModel = modelInput.value.trim();
          const fastModel = fastModelInput ? fastModelInput.value.trim() : undefined;
          if (!targetProfileId || !targetModel) {
            deps.showToast('请选择目标上游并填写模型名称', 'error');
            return;
          }
          bindBtn.disabled = true;
          bindBtn.textContent = '绑定中...';
          try {
            const res = await window.proxyManager.bindAgentModel({
              agent: agentMeta.id,
              profileId: targetProfileId,
              model: targetModel,
              ...(fastModel !== undefined ? { fastModel } : {}),
            });
            if (res && res.ok) {
              deps.showToast(
                `已将 ${agentMeta.name} 绑定到 ${res.profileName || targetProfileId} (${targetModel}${fastModel ? ` + 副模型 ${fastModel}` : ''})`,
                'success'
              );
              await deps.reloadConfigAndRender();
              await refreshAgentHubStatus();
            } else {
              deps.showToast(`绑定失败: ${(res && res.error) || '未知错误'}`, 'error');
            }
          } catch (err) {
            deps.showToast(`绑定异常: ${err.message}`, 'error');
          } finally {
            bindBtn.disabled = false;
            bindBtn.textContent = isProxyActive ? '切换模型/上游' : '一键绑定代理';
          }
        };
        actions.appendChild(bindBtn);

        if (isProxyActive) {
          const restoreBtn = document.createElement('button');
          restoreBtn.className = 'light';
          restoreBtn.style.cssText =
            'margin: 0; padding: 4px 8px; font-size: 12px; min-height: 28px;';
          restoreBtn.textContent = '恢复直连';
          restoreBtn.onclick = async () => {
            restoreBtn.disabled = true;
            try {
              const res = await window.proxyManager.bindAgentModel({
                agent: agentMeta.id,
                action: 'restore',
              });
              if (res && res.ok) {
                deps.showToast(`已恢复 ${agentMeta.name} 官方直连配置`, 'success');
                await refreshAgentHubStatus();
              } else {
                deps.showToast(`恢复失败: ${(res && res.error) || '未知错误'}`, 'error');
              }
            } catch (err) {
              deps.showToast(`恢复异常: ${err.message}`, 'error');
            } finally {
              restoreBtn.disabled = false;
            }
          };
          actions.appendChild(restoreBtn);
        }

        card.append(head, controls, actions);
        return card;
      })
    );
  }

  function buildIdePluginExportSnippet() {
    const cfg = deps.getConfig() || {};
    const profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
    const active = profiles.find((p) => p && p.id === cfg.activeProfile) || profiles[0] || null;
    const defaultModel = inferDefaultModelForProfile(active);
    const httpEntry =
      (Array.isArray(cfg.entryServers) &&
        cfg.entryServers.find((e) => e && e.enabled !== false && e.tls === false)) || {
        host: 'localhost',
        listenPort: 3080,
        basePath: '/v1',
      };
    const httpsEntry =
      (Array.isArray(cfg.entryServers) &&
        cfg.entryServers.find((e) => e && e.enabled !== false && e.tls !== false)) || {
        host: 'localhost',
        listenPort: 3443,
        basePath: '/v1',
      };
    const httpBase = `http://${httpEntry.host || 'localhost'}:${httpEntry.listenPort || 3080}${httpEntry.basePath || '/v1'}`;
    const httpsBase = `https://${httpsEntry.host || 'localhost'}:${httpsEntry.listenPort || 3443}${httpsEntry.basePath || '/v1'}`;

    return [
      '# === Roo Code / Cline / Cursor 本地代理接入配置 ===',
      `# OpenAI Compatible Base URL (HTTP 推荐免证书): ${httpBase}`,
      `# Anthropic / HTTPS Base URL: ${httpsBase}`,
      '# API Key: sk-proxy-managed',
      `# Model ID: ${defaultModel}`,
      '',
      '// --- Continue (~/.continue/config.json) 模型片段 ---',
      JSON.stringify(
        {
          title: `HTTPS-Proxy (${(active && (active.name || active.id)) || 'Default'})`,
          provider: 'openai',
          model: defaultModel,
          apiBase: httpBase,
          apiKey: 'sk-proxy-managed',
        },
        null,
        2
      ),
    ].join('\n');
  }

  function bindQuickPresetBar() {
    const addBtn = deps.$('quickPresetAddBtn');
    const selectEl = deps.$('quickPresetSelect');
    const keyInput = deps.$('quickPresetApiKey');
    const refreshBtn = deps.$('refreshAgentHubBtn');
    const copyIdeBtn = deps.$('copyIdePluginConfigBtn');
    const bindAllBtn = deps.$('bindAllAgentsToActiveBtn');

    if (bindAllBtn) {
      bindAllBtn.onclick = async () => {
        const cfg = deps.getConfig() || {};
        const profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
        const active = profiles.find((p) => p && p.id === cfg.activeProfile) || profiles[0] || null;
        if (!active) {
          deps.showToast('请先添加至少一个上游 Profile', 'error');
          return;
        }
        const model = inferDefaultModelForProfile(active);
        const fastModel = inferFastModelForProfile(active, model);
        bindAllBtn.disabled = true;
        const origText = bindAllBtn.textContent;
        bindAllBtn.textContent = '切换中...';
        try {
          let okCount = 0;
          for (const def of AGENT_DEFINITIONS) {
            const res = await window.proxyManager.bindAgentModel({
              agent: def.id,
              profileId: active.id,
              model,
              fastModel,
            });
            if (res && res.ok) okCount += 1;
          }
          await deps.reloadConfigAndRender();
          await refreshAgentHubStatus();
          deps.showToast(
            `已将 ${okCount} 个编程工具统一绑定到 ${active.name || active.id} (${model})`,
            okCount > 0 ? 'success' : 'error'
          );
        } catch (err) {
          deps.showToast(`全员切换异常: ${err.message}`, 'error');
        } finally {
          bindAllBtn.disabled = false;
          bindAllBtn.textContent = origText;
        }
      };
    }

    if (copyIdeBtn) {
      copyIdeBtn.onclick = async () => {
        const snippet = buildIdePluginExportSnippet();
        try {
          await navigator.clipboard.writeText(snippet);
          deps.showToast('已复制 Roo Code / Cline / Continue / Cursor 接入配置到剪贴板', 'success');
        } catch (err) {
          deps.showToast(`复制失败: ${err.message}`, 'error');
        }
      };
    }

    if (refreshBtn) {
      refreshBtn.onclick = async () => {
        await refreshAgentHubStatus();
        deps.showToast('Agent 绑定与冷却状态已刷新', 'success');
      };
    }

    if (addBtn && selectEl && keyInput) {
      addBtn.onclick = async () => {
        const presetKey = selectEl.value;
        const preset = QUICK_PRESET_DEFINITIONS[presetKey];
        if (!preset) {
          deps.showToast('请先选择要导入的服务商预设', 'error');
          return;
        }
        const apiKey = keyInput.value.trim();
        if (!apiKey && presetKey !== 'ollama') {
          deps.showToast(`请输入 ${preset.name} 的 API Key`, 'error');
          keyInput.focus();
          return;
        }
        addBtn.disabled = true;
        const origText = addBtn.textContent;
        addBtn.textContent = '添加中...';
        try {
          await deps.addQuickProviderPreset({
            ...preset,
            apiKey: apiKey || 'ollama',
          });
          keyInput.value = '';
          renderAgentHub();
        } finally {
          addBtn.disabled = false;
          addBtn.textContent = origText;
        }
      };
    }

    const bindExtraCliPanel = (agentId, label, inputId, applyBtnId, restoreBtnId) => {
      const applyBtn = deps.$(applyBtnId);
      const restoreBtn = deps.$(restoreBtnId);
      if (applyBtn) {
        applyBtn.onclick = async () => {
          const model = (deps.$(inputId)?.value || '').trim() || 'deepseek-chat';
          const cfg = deps.getConfig();
          const profileId = (cfg && cfg.activeProfile) || cfg?.profiles?.[0]?.id || '';
          const res = await window.proxyManager.bindAgentModel({
            agent: agentId,
            profileId,
            model,
          });
          if (res && res.ok) {
            deps.showToast(`已将 ${label} 绑定到本地代理 (${model})`, 'success');
            await deps.reloadConfigAndRender();
            await refreshAgentHubStatus();
          } else {
            deps.showToast(`应用失败: ${(res && res.error) || '未知错误'}`, 'error');
          }
        };
      }
      if (restoreBtn) {
        restoreBtn.onclick = async () => {
          const res = await window.proxyManager.bindAgentModel({
            agent: agentId,
            action: 'restore',
          });
          if (res && res.ok) {
            deps.showToast(`已恢复 ${label} 原配置`, 'success');
            await refreshAgentHubStatus();
          } else {
            deps.showToast(`恢复失败: ${(res && res.error) || '未知错误'}`, 'error');
          }
        };
      }
    };

    bindExtraCliPanel(
      'opencode',
      'OpenCode CLI',
      'opencodeCliModel',
      'applyOpenCodeCli',
      'restoreOpenCodeCli'
    );
    bindExtraCliPanel('aider', 'Aider CLI', 'aiderCliModel', 'applyAiderCli', 'restoreAiderCli');
  }

  return {
    bindQuickPresetBar,
    renderAgentHub,
    refreshAgentHubStatus,
  };
}
