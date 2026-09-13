import { bindDomainDependencies } from '../runtime/dependencies.js';
import {
  createChatMessage,
  parseStreamChunk,
  calculateGenerationStats,
  estimateTokenCount,
} from '../models/playground.js';

let playgroundDeps = null;

export function configurePlayground(dependencies) {
  playgroundDeps = bindDomainDependencies('playground', dependencies, [
    '$',
    'clearElement',
    'showToast',
  ]);
}

const playgroundState = {
  mode: 'single',
  modelA: '',
  modelB: '',
  temperature: 0.7,
  stream: true,
  isStreaming: false,
  messagesA: [],
  messagesB: [],
};

const PRESET_PROMPTS = [
  { label: '⚡ 极速测速', text: '请用简洁的一句话介绍你自己，并给出当前时间。' },
  {
    label: '🧠 深度推理',
    text: '有9个外观相同的小球，其中1个较重。用天平最少称几次能保证找出重球？请详细写出推理步骤。',
  },
  { label: '💻 代码生成', text: '用 JavaScript 写一个高效的 LRU Cache 类，包含 get 和 put 方法。' },
  { label: '🌐 联网/工具验证', text: '请搜索或查询 2026 年人工智能和代理网关领域的最新技术动向。' },
];

export async function initPlaygroundView() {
  const container = playgroundDeps.$('playgroundView');
  if (!container) return;

  if (!container.dataset.initialized) {
    container.dataset.initialized = 'true';
    setupPlaygroundEvents();
  }

  await refreshPlaygroundModels();
}

function setupPlaygroundEvents() {
  const modeSingle = playgroundDeps.$('pgModeSingle');
  const modeDual = playgroundDeps.$('pgModeDual');
  const sendBtn = playgroundDeps.$('pgSendBtn');
  const clearBtn = playgroundDeps.$('pgClearBtn');
  const input = playgroundDeps.$('pgUserInput');
  const tempInput = playgroundDeps.$('pgTemperature');
  const streamInput = playgroundDeps.$('pgStream');
  const modelASelect = playgroundDeps.$('pgModelA');
  const modelBSelect = playgroundDeps.$('pgModelB');

  if (modeSingle) {
    modeSingle.onclick = () => setPlaygroundMode('single');
  }
  if (modeDual) {
    modeDual.onclick = () => setPlaygroundMode('dual');
  }

  if (modelASelect) {
    modelASelect.onchange = () => {
      playgroundState.modelA = modelASelect.value;
      updateColumnHeaders();
    };
  }
  if (modelBSelect) {
    modelBSelect.onchange = () => {
      playgroundState.modelB = modelBSelect.value;
      updateColumnHeaders();
    };
  }

  if (tempInput) {
    tempInput.onchange = () => {
      playgroundState.temperature = Math.max(0, Math.min(2, parseFloat(tempInput.value) || 0.7));
    };
  }

  if (streamInput) {
    streamInput.onchange = () => {
      playgroundState.stream = streamInput.checked;
    };
  }

  if (sendBtn) {
    sendBtn.onclick = () => handleSend();
  }

  if (clearBtn) {
    clearBtn.onclick = () => clearPlaygroundChat();
  }

  if (input) {
    input.onkeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSend();
      }
    };
  }

  renderPresetPromptTags();
}

function renderPresetPromptTags() {
  const container = playgroundDeps.$('pgPresetTags');
  if (!container) return;
  playgroundDeps.clearElement(container);

  PRESET_PROMPTS.forEach((preset) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'light';
    btn.style.padding = '3px 8px';
    btn.style.fontSize = '11px';
    btn.style.margin = '0 4px 4px 0';
    btn.textContent = preset.label;
    btn.onclick = () => {
      const input = playgroundDeps.$('pgUserInput');
      if (input) {
        input.value = preset.text;
        input.focus();
      }
    };
    container.appendChild(btn);
  });
}

export function setPlaygroundMode(mode) {
  playgroundState.mode = mode;
  const singleBtn = playgroundDeps.$('pgModeSingle');
  const dualBtn = playgroundDeps.$('pgModeDual');
  const colB = playgroundDeps.$('pgColumnBWrapper');
  const modelBSelect = playgroundDeps.$('pgModelB');
  const chatGrid = playgroundDeps.$('pgChatGrid');

  if (mode === 'single') {
    if (singleBtn) singleBtn.classList.add('active');
    if (dualBtn) dualBtn.classList.remove('active');
    if (colB) colB.style.display = 'none';
    if (modelBSelect) modelBSelect.style.display = 'none';
    if (chatGrid) chatGrid.style.gridTemplateColumns = '1fr';
  } else {
    if (singleBtn) singleBtn.classList.remove('active');
    if (dualBtn) dualBtn.classList.add('active');
    if (colB) colB.style.display = 'flex';
    if (modelBSelect) modelBSelect.style.display = 'inline-block';
    if (chatGrid) chatGrid.style.gridTemplateColumns = '1fr 1fr';
  }
  updateColumnHeaders();
}

function updateColumnHeaders() {
  const headerA = playgroundDeps.$('pgHeaderA');
  const headerB = playgroundDeps.$('pgHeaderB');
  if (headerA) {
    headerA.textContent = `模型 A: ${playgroundState.modelA || '未选择'}`;
  }
  if (headerB) {
    headerB.textContent = `模型 B (对比): ${playgroundState.modelB || '未选择'}`;
  }
}

export async function refreshPlaygroundModels() {
  try {
    const res = await window.proxyManager.getConfig();
    if (!res || !res.ok || !res.config) return;

    const config = res.config;
    const modelSet = new Set();

    if (Array.isArray(config.profiles)) {
      config.profiles.forEach((p) => {
        if (p && p.model) modelSet.add(p.model);
        if (p && p.id) modelSet.add(p.id);
      });
    }

    if (Array.isArray(config.routes)) {
      config.routes.forEach((r) => {
        if (r && r.model) modelSet.add(r.model);
      });
    }

    const defaultModels = ['claude-3-7-sonnet', 'gpt-4o', 'deepseek-chat', 'glm-4-flash'];
    defaultModels.forEach((m) => modelSet.add(m));

    const modelASelect = playgroundDeps.$('pgModelA');
    const modelBSelect = playgroundDeps.$('pgModelB');

    const models = Array.from(modelSet);

    if (modelASelect) {
      const prevA = modelASelect.value || models[0];
      playgroundDeps.clearElement(modelASelect);
      models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        modelASelect.appendChild(opt);
      });
      modelASelect.value = prevA;
      playgroundState.modelA = modelASelect.value;
    }

    if (modelBSelect) {
      const prevB = modelBSelect.value || (models.length > 1 ? models[1] : models[0]);
      playgroundDeps.clearElement(modelBSelect);
      models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        modelBSelect.appendChild(opt);
      });
      modelBSelect.value = prevB;
      playgroundState.modelB = modelBSelect.value;
    }

    updateColumnHeaders();
  } catch {
    // Ignore refresh error
  }
}

async function resolveProxyChatUrl() {
  try {
    const res = await window.proxyManager.getConfig();
    if (res && res.ok && res.config && Array.isArray(res.config.entryServers)) {
      const entry = res.config.entryServers.find(
        (e) =>
          e &&
          e.enabled !== false &&
          (e.protocol === 'openai' || e.protocol === 'openai-responses') &&
          e.tls === false
      );
      if (entry) {
        const host = entry.host === '0.0.0.0' ? '127.0.0.1' : entry.host || '127.0.0.1';
        const port = entry.listenPort || 3084;
        const basePath = (entry.basePath || '/v1').replace(/\/+$/, '');
        return `http://${host}:${port}${basePath}/chat/completions`;
      }
    }
  } catch {
    // fallback
  }
  return 'http://127.0.0.1:3084/v1/chat/completions';
}

async function handleSend() {
  const input = playgroundDeps.$('pgUserInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  if (playgroundState.isStreaming) {
    playgroundDeps.showToast('当前请求正在处理中，请稍候', 'info');
    return;
  }

  input.value = '';
  playgroundState.isStreaming = true;
  updateSendButtonState(true);

  const userMsgA = createChatMessage('user', text);
  const userMsgB = createChatMessage('user', text);
  playgroundState.messagesA.push(userMsgA);
  playgroundState.messagesB.push(userMsgB);

  renderChatMessage('pgChatColumnA', userMsgA);
  if (playgroundState.mode === 'dual') {
    renderChatMessage('pgChatColumnB', userMsgB);
  }

  const endpoint = await resolveProxyChatUrl();

  const runStreamA = streamCompletion(
    'pgChatColumnA',
    playgroundState.modelA,
    playgroundState.messagesA,
    endpoint
  );

  const tasks = [runStreamA];

  if (playgroundState.mode === 'dual') {
    const runStreamB = streamCompletion(
      'pgChatColumnB',
      playgroundState.modelB,
      playgroundState.messagesB,
      endpoint
    );
    tasks.push(runStreamB);
  }

  try {
    await Promise.allSettled(tasks);
  } finally {
    playgroundState.isStreaming = false;
    updateSendButtonState(false);
  }
}

async function streamCompletion(columnId, model, messageHistory, endpoint) {
  const assistantMsg = createChatMessage('assistant', '', { model });
  messageHistory.push(assistantMsg);

  const { msgElement, thinkingPre, thinkingDetails, contentDiv, metricsDiv } =
    createAssistantMessageElement(assistantMsg);
  const chatCol = playgroundDeps.$(columnId);
  if (chatCol) {
    chatCol.appendChild(msgElement);
    chatCol.scrollTop = chatCol.scrollHeight;
  }

  const startTime = Date.now();
  let firstTokenTime = null;
  let tokenCount = 0;

  const payload = {
    model: model || 'gpt-4o',
    messages: messageHistory.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
    temperature: playgroundState.temperature,
    stream: playgroundState.stream,
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-playground-key',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      contentDiv.textContent = `[请求失败 ${response.status}]: ${errText}`;
      contentDiv.style.color = '#ef4444';
      return;
    }

    if (!playgroundState.stream || !response.body) {
      const json = await response.json();
      const answer = json.choices?.[0]?.message?.content || JSON.stringify(json);
      assistantMsg.content = answer;
      contentDiv.textContent = answer;
      const stats = calculateGenerationStats(
        startTime,
        startTime,
        Date.now(),
        estimateTokenCount(answer)
      );
      metricsDiv.textContent = `⏱️ 首字: ${stats.ttftMs}ms | 速度: ${stats.tokensPerSecond} tokens/s | 耗时: ${(stats.totalDurationMs / 1000).toFixed(2)}s | Token 估算: ${stats.tokenCount}`;
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        if (trimmed === 'data: [DONE]') break;

        const parsed = parseStreamChunk(trimmed);
        if (parsed.thinkingDelta) {
          if (!firstTokenTime) firstTokenTime = Date.now();
          assistantMsg.thinking += parsed.thinkingDelta;
          thinkingPre.textContent = assistantMsg.thinking;
          thinkingDetails.style.display = 'block';
          tokenCount += estimateTokenCount(parsed.thinkingDelta);
        }

        if (parsed.textDelta) {
          if (!firstTokenTime) firstTokenTime = Date.now();
          assistantMsg.content += parsed.textDelta;
          contentDiv.textContent = assistantMsg.content;
          tokenCount += estimateTokenCount(parsed.textDelta);
        }

        if (firstTokenTime) {
          const stats = calculateGenerationStats(startTime, firstTokenTime, Date.now(), tokenCount);
          metricsDiv.textContent = `⏱️ 首字: ${stats.ttftMs}ms | 速度: ${stats.tokensPerSecond} tokens/s | 耗时: ${(stats.totalDurationMs / 1000).toFixed(2)}s | Token: ~${tokenCount}`;
        }

        if (chatCol) {
          chatCol.scrollTop = chatCol.scrollHeight;
        }
      }
    }

    const finalStats = calculateGenerationStats(
      startTime,
      firstTokenTime || Date.now(),
      Date.now(),
      tokenCount || estimateTokenCount(assistantMsg.content)
    );
    assistantMsg.stats = finalStats;
    metricsDiv.textContent = `⏱️ 首字: ${finalStats.ttftMs}ms | 速度: ${finalStats.tokensPerSecond} tokens/s | 耗时: ${(finalStats.totalDurationMs / 1000).toFixed(2)}s | Token: ~${finalStats.tokenCount}`;
  } catch (err) {
    contentDiv.textContent = `[网络或代理异常]: ${err.message}`;
    contentDiv.style.color = '#ef4444';
  }
}

function renderChatMessage(columnId, msg) {
  const chatCol = playgroundDeps.$(columnId);
  if (!chatCol) return;

  const wrapper = document.createElement('div');
  wrapper.className = `playground-msg playground-msg-${msg.role}`;
  wrapper.style.display = 'flex';
  wrapper.style.flexDirection = 'column';
  wrapper.style.alignSelf = msg.role === 'user' ? 'flex-end' : 'flex-start';
  wrapper.style.maxWidth = '85%';
  wrapper.style.padding = '8px 12px';
  wrapper.style.borderRadius = '10px';
  wrapper.style.marginBottom = '8px';
  wrapper.style.wordBreak = 'break-word';

  if (msg.role === 'user') {
    wrapper.style.background = 'var(--primary)';
    wrapper.style.color = '#ffffff';
    wrapper.textContent = msg.content;
  }
  chatCol.appendChild(wrapper);
  chatCol.scrollTop = chatCol.scrollHeight;
}

function createAssistantMessageElement(msg) {
  const msgElement = document.createElement('div');
  msgElement.className = 'playground-msg playground-msg-assistant';
  msgElement.style.display = 'flex';
  msgElement.style.flexDirection = 'column';
  msgElement.style.alignSelf = 'flex-start';
  msgElement.style.width = '94%';
  msgElement.style.maxWidth = '94%';
  msgElement.style.padding = '10px 14px';
  msgElement.style.borderRadius = '10px';
  msgElement.style.marginBottom = '12px';
  msgElement.style.border = '1px solid var(--border)';
  msgElement.style.background = 'var(--card-highlight, rgba(0, 0, 0, 0.02))';
  msgElement.style.wordBreak = 'break-word';

  const thinkingDetails = document.createElement('details');
  thinkingDetails.open = true;
  thinkingDetails.style.display = 'none';
  thinkingDetails.style.marginBottom = '8px';
  thinkingDetails.style.padding = '6px 10px';
  thinkingDetails.style.borderRadius = '6px';
  thinkingDetails.style.background = 'rgba(0, 0, 0, 0.04)';
  thinkingDetails.style.borderLeft = '3px solid var(--primary)';

  const thinkingSummary = document.createElement('summary');
  thinkingSummary.style.cursor = 'pointer';
  thinkingSummary.style.fontSize = '12px';
  thinkingSummary.style.fontWeight = '600';
  thinkingSummary.style.color = 'var(--muted)';
  thinkingSummary.textContent = '🧠 思考链 (Thinking / Reasoning)';
  thinkingDetails.appendChild(thinkingSummary);

  const thinkingPre = document.createElement('pre');
  thinkingPre.style.whiteSpace = 'pre-wrap';
  thinkingPre.style.fontFamily = 'var(--font-mono)';
  thinkingPre.style.fontSize = '11px';
  thinkingPre.style.color = 'var(--muted)';
  thinkingPre.style.margin = '6px 0 0 0';
  thinkingDetails.appendChild(thinkingPre);

  const contentDiv = document.createElement('div');
  contentDiv.style.fontSize = '13.5px';
  contentDiv.style.lineHeight = '1.6';
  contentDiv.style.whiteSpace = 'pre-wrap';

  const metricsDiv = document.createElement('div');
  metricsDiv.style.fontSize = '11px';
  metricsDiv.style.fontFamily = 'var(--font-mono)';
  metricsDiv.style.color = 'var(--muted)';
  metricsDiv.style.marginTop = '8px';
  metricsDiv.style.borderTop = '1px dashed var(--border)';
  metricsDiv.style.paddingTop = '4px';

  msgElement.append(thinkingDetails, contentDiv, metricsDiv);

  return { msgElement, thinkingDetails, thinkingPre, contentDiv, metricsDiv };
}

function updateSendButtonState(isStreaming) {
  const sendBtn = playgroundDeps.$('pgSendBtn');
  if (!sendBtn) return;
  if (isStreaming) {
    sendBtn.disabled = true;
    sendBtn.textContent = '正在生成...';
  } else {
    sendBtn.disabled = false;
    sendBtn.textContent = '发送 (Ctrl+Enter)';
  }
}

export function clearPlaygroundChat() {
  playgroundState.messagesA = [];
  playgroundState.messagesB = [];
  const colA = playgroundDeps.$('pgChatColumnA');
  const colB = playgroundDeps.$('pgChatColumnB');
  if (colA) playgroundDeps.clearElement(colA);
  if (colB) playgroundDeps.clearElement(colB);
  playgroundDeps.showToast('对话已清空', 'info');
}
