import { bindDomainDependencies } from '../runtime/dependencies.js';

const PROMPT_CLIENT_TYPES = new Set(['claude', 'antigravity', 'codex', 'gemini']);
const PROMPT_SAVE_DELAY_MS = 400;

let promptDependencies;
let promptContentSaveTimer = null;
let activePromptClientType = 'claude';

export function configurePrompts(runtime) {
  promptDependencies = bindDomainDependencies('prompts', runtime, [
    '$',
    'config',
    'showToast',
    'storage',
  ]);
}

function dependencies() {
  if (!promptDependencies) {
    throw new Error('prompts domain is not configured');
  }
  return promptDependencies;
}

export function normalizePromptClientType(value) {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PROMPT_CLIENT_TYPES.has(candidate) ? candidate : 'claude';
}

function promptStorageKey(type) {
  return `prompt_content_${normalizePromptClientType(type)}`;
}

function promptElements() {
  const { $ } = dependencies();
  return {
    clientType: $('promptClientType'),
    content: $('promptContent'),
  };
}

export function persistPromptContentNow(type, content) {
  const elements = promptElements();
  const resolvedType = type ?? (elements.clientType && elements.clientType.value);
  const resolvedContent = content ?? (elements.content && elements.content.value) ?? '';
  if (promptContentSaveTimer) {
    clearTimeout(promptContentSaveTimer);
    promptContentSaveTimer = null;
  }
  localStorage.setItem(promptStorageKey(resolvedType), String(resolvedContent));
}

function schedulePromptContentPersist() {
  const { clientType, content } = promptElements();
  if (!clientType || !content) return;
  const type = clientType.value;
  const value = content.value;
  if (promptContentSaveTimer) clearTimeout(promptContentSaveTimer);
  promptContentSaveTimer = setTimeout(() => {
    promptContentSaveTimer = null;
    localStorage.setItem(promptStorageKey(type), value);
  }, PROMPT_SAVE_DELAY_MS);
}

function safeResponseText(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 1000) : fallback;
}

export function parsePromptSyncResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: '服务返回了无效响应' };
  }
  if (value.ok === true) {
    return {
      ok: true,
      path: safeResponseText(value.path, '未知路径'),
    };
  }
  return {
    ok: false,
    error: safeResponseText(value.error, '同步失败'),
  };
}

async function syncPrompt() {
  const { $, config, showToast } = dependencies();
  const clientType = $('promptClientType');
  const promptContent = $('promptContent');
  const syncButton = $('syncPromptBtn');
  const output = $('output');
  if (!clientType || !promptContent || !syncButton) return;

  persistPromptContentNow(clientType.value, promptContent.value);
  const type = normalizePromptClientType(clientType.value);
  const content = promptContent.value;
  syncButton.disabled = true;
  syncButton.textContent = '同步中...';

  const configuredPort = Number(config && config.localServer && config.localServer.listenPort);
  const port =
    Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
      ? configuredPort
      : 3443;
  const baseUrl = !window.__TAURI__ ? '' : `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(`${baseUrl}/v1/local/prompts/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type, content }),
    });
    const data = parsePromptSyncResponse(await response.json());
    if (data.ok) {
      showToast(`提示词已成功同步到：${data.path}`);
      if (output) output.textContent = `提示词同步成功！路径：${data.path}`;
    } else {
      showToast(`同步失败：${data.error}`, 'error');
      if (output) output.textContent = `同步失败：${data.error}`;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`请求失败：${message}`, 'error');
    if (output) output.textContent = `请求失败：${message}`;
  } finally {
    syncButton.disabled = false;
    syncButton.textContent = '一键同步到本地助手';
  }
}

// 系统预置提示词插件列表
const SYSTEM_PRESET_PROMPTS = [
  {
    name: '简约开发助手 (KISS)',
    desc: '倡导模块化与避免过度设计，严格遵守简约至上原则。',
    content:
      '# Role\n你是一个追求极简设计与高可维护性的代码重构和软件开发专家。\n\n# 核心原则 (KISS)\n1. 简洁至上：不写不需要的代码，拒绝过度工程与不必要的防御性设计。\n2. 模块化：保持方法短小精悍，职责单一。\n3. 良好文档：为复杂的非直观逻辑编写清晰的内联注释。',
  },
  {
    name: '代码重构大师',
    desc: '渐进式重构代码，消除条件嵌套，保持 API 签名完全兼容。',
    content:
      '# Role\n你是一个严谨的资深系统架构师，擅长发现既有代码库中的瓶颈并进行渐进式重构。\n\n# 核心原则\n1. 兼容性：严禁破坏原有的公共 API 或公共方法签名。\n2. 可读性：通过引入清晰的中间变量、消除嵌套条件分支来提升代码表现力。\n3. 性能：定位高频热循环，并在必要时提供优化和 Benchmark 建议。',
  },
  {
    name: 'Bug 诊断侦探',
    desc: '追踪异常还原诱因，细致搜查空引用溢出，以最小改动解决缺陷。',
    content:
      '# Role\n你是一个逻辑严密的软件调试专家，擅长从异常栈和日志中顺藤摸瓜定位问题根本。\n\n# 核心原则\n1. 溯源分析：不要只修复表象，深入推导问题的根本诱因。\n2. 边界检查：重点检查空指针（NPE）、越界、并发竞争和类型转换异常。\n3. 最小改动：用最少、最优雅的代码修改来解决问题，严防引入新缺陷。',
  },
  {
    name: 'Git 提交规范器',
    desc: '一键将近期变更整理并格式化为 Angular Git Commit 统一规范。',
    content:
      '# Role\n你是一个专业的 Git 工作流管理专家，协助开发者生成完美遵循 Angular 规范的提交日志。\n\n# 核心原则\n提交日志格式应为：\n`<type>(<scope>): <subject>`\n\n常见 `<type>`:\n- feat: 新功能\n- fix: 修复 Bug\n- docs: 文档变更\n- style: 代码格式调整（不影响逻辑）\n- refactor: 重构（既非新增也非修复）\n- test: 添加或修改测试\n- chore: 构建工具或辅助工具的变动',
  },
  {
    name: '单元测试大师',
    desc: '编写高可靠单元测试，包含全边界模拟，隔离外部依赖及网络。',
    content:
      '# Role\n你是一个追求高覆盖率与防御性测试的软件测试工程专家。\n\n# 核心原则\n1. 边界覆盖：为目标方法编写包含正常参数、最大/最小边界值、空值与异常输入的测试用例。\n2. 单一断言：尽量保持单元测试紧凑，每次重点验证一个逻辑分支。\n3. Mock 隔离：合理使用 Mock 框架隔离第三方依赖或数据库网络调用。',
  },
  {
    name: 'PRD 需求撰写专家',
    desc: '梳理业务核心价值、痛点及细分功能，建立清晰验收标准（AC）。',
    content:
      '# Role\n你是一个具备严密逻辑与同理心的资深产品经理，擅长将零散的想法转化为结构清晰、逻辑严谨的产品需求文档（PRD）。\n\n# 核心原则\n1. 业务价值：清晰界定目标用户痛点、用户画像及此功能能带来的商业/体验价值。\n2. 需求拆解：将大功能拆分为细粒度的功能点列表。\n3. 规则细节：详细梳理输入限制、状态变迁、网络异常等边界规则。\n4. 验收标准：为每一个功能点编写清晰的测试用例与验收条件 (AC)。',
  },
  {
    name: '业务流程梳理师',
    desc: '分析复杂的业务流转链路，设计异常降级与状态演变矩阵。',
    content:
      '# Role\n你是一个精通系统交互与状态演变的产品系统架构分析师。\n\n# 核心原则\n1. 主流程：清晰梳理从起点到终点的核心用户交互链路。\n2. 异常分支：重点罗列网络中断、鉴权失败、取消操作等异常链路的降级体验。\n3. 状态变迁：为关键业务实体（如订单、审批）制定清晰的状态转移矩阵（Status Matrix）。',
  },
  {
    name: '竞品分析探针',
    desc: '对比多维度优劣势，分析用户痛点与交互死角，寻找差异化切入点。',
    content:
      '# Role\n你是一个洞察敏锐的商业分析与用户体验（UX）研究专家。\n\n# 核心原则\n1. 多维对比：从商业模式、功能完备度、用户交互、性能体验四个维度深度对比竞品。\n2. 优势放大：提炼出我方可实现差异化竞争的“杀手级特性”。\n3. 痛点定位：分析竞品中用户反响强烈的核心槽点，转化为我方的设计机会点。',
  },
];

export function togglePromptsTab(tabId) {
  const { $ } = dependencies();
  const isPreset = tabId === 'tabPresetPrompts';
  const presetTab = $('tabPresetPrompts');
  const customTab = $('tabCustomPrompts');
  const presetPanel = $('presetPromptsPanel');
  const customPanel = $('customPromptsPanel');
  if (!presetTab || !customTab || !presetPanel || !customPanel) return;

  const activeTab = isPreset ? presetTab : customTab;
  const inactiveTab = isPreset ? customTab : presetTab;
  activeTab.classList.add('active');
  activeTab.setAttribute('aria-selected', 'true');
  activeTab.style.border = '1px solid var(--border)';
  activeTab.style.background = 'var(--light-bg)';
  activeTab.style.color = 'var(--text)';
  inactiveTab.classList.remove('active');
  inactiveTab.setAttribute('aria-selected', 'false');
  inactiveTab.style.border = '1px solid transparent';
  inactiveTab.style.background = 'transparent';
  inactiveTab.style.color = 'var(--muted)';
  presetPanel.style.display = isPreset ? 'flex' : 'none';
  customPanel.style.display = isPreset ? 'none' : 'flex';
  if (isPreset) presetPanel.removeAttribute('aria-hidden');
  else presetPanel.setAttribute('aria-hidden', 'true');
  if (isPreset) customPanel.setAttribute('aria-hidden', 'true');
  else customPanel.removeAttribute('aria-hidden');
}

export function initPromptsTabSwitching() {
  const { $ } = dependencies();
  const presetTab = $('tabPresetPrompts');
  const customTab = $('tabCustomPrompts');
  if (presetTab && !presetTab.dataset.bound) {
    presetTab.dataset.bound = 'true';
    presetTab.onclick = () => togglePromptsTab('tabPresetPrompts');
  }
  if (customTab && !customTab.dataset.bound) {
    customTab.dataset.bound = 'true';
    customTab.onclick = () => togglePromptsTab('tabCustomPrompts');
  }
}

function createPresetPromptItemElement(template, index) {
  const item = document.createElement('div');
  item.className = 'profile';
  item.dataset.presetIndex = String(index);
  item.style.padding = '12px 14px';
  item.style.marginBottom = '0';
  item.style.display = 'flex';
  item.style.flexDirection = 'column';
  item.style.gap = '6px';
  item.style.cursor = 'pointer';
  item.style.transition = 'all 0.2s';

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';

  const name = document.createElement('span');
  name.style.fontWeight = '700';
  name.style.fontSize = '12.5px';
  name.style.color = 'var(--text)';
  name.textContent = template.name;

  const badge = document.createElement('span');
  badge.className = 'audit-badge info';
  badge.style.fontSize = '9px';
  badge.style.padding = '1px 4px';
  badge.style.fontWeight = '600';
  badge.style.textTransform = 'uppercase';
  badge.textContent = '官方插件';

  const description = document.createElement('div');
  description.style.fontSize = '11px';
  description.style.color = 'var(--muted)';
  description.style.lineHeight = '1.4';
  description.textContent = template.desc;

  header.appendChild(name);
  header.appendChild(badge);
  item.appendChild(header);
  item.appendChild(description);
  return item;
}

function createTemplateEmptyElement() {
  const empty = document.createElement('div');
  empty.style.padding = '16px';
  empty.style.textAlign = 'center';
  empty.style.color = 'var(--muted)';
  empty.style.fontSize = '11px';
  empty.textContent = '暂无自定义模板。可在上方输入模版名称，将左侧 Markdown 内容保存为本地插件。';
  return empty;
}

export function loadPresetPrompts() {
  const { $, showToast } = dependencies();
  const listContainer = $('presetPromptsPanel');
  if (!listContainer) return;
  listContainer.textContent = '';
  if (!listContainer.dataset.delegated) {
    listContainer.dataset.delegated = 'true';
    listContainer.onclick = (event) => {
      const item = event.target.closest('[data-preset-index]');
      if (!item || !listContainer.contains(item)) return;
      const template = SYSTEM_PRESET_PROMPTS[Number(item.dataset.presetIndex)];
      if (!template) return;
      $('promptContent').value = template.content;
      persistPromptContentNow($('promptClientType').value, template.content);
      showToast(`已加载插件: ${template.name}`);
    };
  }
  SYSTEM_PRESET_PROMPTS.forEach((template, index) => {
    listContainer.appendChild(createPresetPromptItemElement(template, index));
  });
}

export function readStoredPromptTemplates() {
  return dependencies().storage.parsePromptTemplates(
    localStorage.getItem('prompt_templates') || '[]'
  );
}

export function loadTemplates() {
  const { $, showToast } = dependencies();
  const listContainer = $('templateList');
  if (!listContainer) return;
  listContainer.textContent = '';
  if (!listContainer.dataset.delegated) {
    listContainer.dataset.delegated = 'true';
    listContainer.onclick = (event) => {
      const deleteButton = event.target.closest('[data-template-delete]');
      const item = event.target.closest('[data-template-index]');
      if (!item || !listContainer.contains(item)) return;
      const index = Number(item.dataset.templateIndex);
      const templates = readStoredPromptTemplates();
      const template = templates[index];
      if (!template) return;
      if (deleteButton && listContainer.contains(deleteButton)) {
        if (confirm(`确认要删除模板 "${template.name}" 吗？`)) {
          templates.splice(index, 1);
          localStorage.setItem('prompt_templates', JSON.stringify(templates));
          loadTemplates();
          showToast('模板已删除');
        }
        return;
      }
      $('promptContent').value = template.content;
      persistPromptContentNow($('promptClientType').value, template.content);
      showToast(`已加载模板: ${template.name}`);
    };
  }

  const templates = readStoredPromptTemplates();
  if (templates.length === 0) {
    listContainer.appendChild(createTemplateEmptyElement());
    return;
  }
  templates.forEach((template, index) => {
    const item = document.createElement('div');
    item.className = 'profile';
    item.dataset.templateIndex = String(index);
    item.style.padding = '8px 10px';
    item.style.marginBottom = '0';
    item.style.display = 'flex';
    item.style.justifyContent = 'space-between';
    item.style.alignItems = 'center';
    item.style.gap = '8px';

    const title = document.createElement('span');
    title.style.cursor = 'pointer';
    title.style.fontWeight = '600';
    title.style.fontSize = '12.5px';
    title.style.flex = '1';
    title.style.overflow = 'hidden';
    title.style.textOverflow = 'ellipsis';
    title.style.whiteSpace = 'nowrap';
    title.textContent = template.name;

    const deleteButton = document.createElement('button');
    deleteButton.className = 'danger';
    deleteButton.dataset.templateDelete = String(index);
    deleteButton.style.padding = '2px 6px';
    deleteButton.style.margin = '0';
    deleteButton.style.minHeight = '22px';
    deleteButton.style.fontSize = '10px';
    deleteButton.style.borderRadius = '4px';
    deleteButton.style.boxShadow = 'none';
    deleteButton.textContent = '删除';

    item.appendChild(title);
    item.appendChild(deleteButton);
    listContainer.appendChild(item);
  });
}

function saveTemplate() {
  const { $, showToast } = dependencies();
  persistPromptContentNow();
  const name = $('templateNameInput').value.trim();
  const content = $('promptContent').value;
  if (!name) {
    showToast('请输入模板名称', 'error');
    return;
  }
  if (!content.trim()) {
    showToast('提示词内容不能为空', 'error');
    return;
  }
  const storageLimits = dependencies().storage.limits;
  if (name.length > storageLimits.promptNameChars) {
    showToast(`模板名称不能超过 ${storageLimits.promptNameChars} 个字符`, 'error');
    return;
  }
  if (content.length > storageLimits.promptContentChars) {
    showToast(`模板内容不能超过 ${storageLimits.promptContentChars} 个字符`, 'error');
    return;
  }

  const templates = readStoredPromptTemplates();
  const existingIndex = templates.findIndex((template) => template.name === name);
  if (existingIndex >= 0) {
    if (!confirm(`已存在同名模板 "${name}"，是否覆盖？`)) return;
    templates[existingIndex].content = content;
  } else {
    templates.push({ name, content });
  }

  localStorage.setItem('prompt_templates', JSON.stringify(templates));
  $('templateNameInput').value = '';
  loadTemplates();
  showToast('模板保存成功');
}

export function bindPromptControls() {
  const { $ } = dependencies();
  const clientType = $('promptClientType');
  const content = $('promptContent');
  const syncButton = $('syncPromptBtn');
  const saveButton = $('saveTemplateBtn');

  if (clientType && !clientType.dataset.promptBound) {
    clientType.dataset.promptBound = 'true';
    activePromptClientType = normalizePromptClientType(clientType.value);
    clientType.onchange = () => {
      if (!content) return;
      persistPromptContentNow(activePromptClientType, content.value);
      activePromptClientType = normalizePromptClientType(clientType.value);
      content.value = localStorage.getItem(promptStorageKey(activePromptClientType)) || '';
    };
  }
  if (content && !content.dataset.promptBound) {
    content.dataset.promptBound = 'true';
    content.oninput = schedulePromptContentPersist;
  }
  if (syncButton && !syncButton.dataset.promptBound) {
    syncButton.dataset.promptBound = 'true';
    syncButton.onclick = syncPrompt;
  }
  if (saveButton && !saveButton.dataset.promptBound) {
    saveButton.dataset.promptBound = 'true';
    saveButton.onclick = saveTemplate;
  }
}
