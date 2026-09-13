import { bindDomainDependencies } from '../runtime/dependencies.js';

let mcpDependencies;

export function configureMcp(dependencies) {
  mcpDependencies = bindDomainDependencies('mcp', dependencies, ['$', 'clearElement', 'showToast']);
}

// MCP Hub UI logic.

let mcpHubConfig = { servers: [], routing: [] };

const GLM_MCP_TEMPLATES = {
  webSearchPrime: {
    id: 'glm-web-search',
    url: 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp',
    prefix: 'glm_search',
    injectAll: true,
  },
};

async function initMcpHubView() {
  const container = mcpDependencies.$('mcpHubView');
  if (!container || container.dataset.initialized) {
    refreshMcpHub();
    return;
  }
  container.dataset.initialized = 'true';

  mcpDependencies.$('refreshMcpHub').onclick = () => refreshMcpHub();
  mcpDependencies.$('addMcpServer').onclick = () => addMcpServer();
  const addGlmSearchButton = mcpDependencies.$('addGlmSearchMcpServer');
  if (addGlmSearchButton) addGlmSearchButton.onclick = () => addGlmSearchMcpServer();
  mcpDependencies.$('saveMcpHub').onclick = () => saveMcpHub();

  refreshMcpHub();
}

async function refreshMcpHub() {
  const status = mcpDependencies.$('mcpHubStatus');
  status.textContent = '正在加载 MCP 配置...';

  try {
    const res = await window.proxyManager.mcpHubGet();
    if (res.ok) {
      mcpHubConfig = res.mcpHub;
      renderMcpServers();
      status.textContent = `已加载 ${mcpHubConfig.servers.length} 个服务器，${mcpHubConfig.routing.length} 条路由规则。`;
    } else {
      status.textContent = '加载 MCP 配置失败：' + (res.error || '未知错误');
    }

    const logsRes = await window.proxyManager.mcpHubLogs();
    if (logsRes.ok) {
      renderMcpLogs(logsRes.logs);
    }
  } catch (err) {
    status.textContent = '加载失败：' + err.message;
  }
}

function renderMcpServers() {
  const container = mcpDependencies.$('mcpServersList');
  mcpDependencies.clearElement(container);
  if (!mcpHubConfig || !mcpHubConfig.servers || mcpHubConfig.servers.length === 0) {
    container.appendChild(createMcpServersEmptyElement());
    return;
  }

  container.appendChild(createMcpServersTableElement(mcpHubConfig.servers));
}

function createMcpServersEmptyElement() {
  const empty = document.createElement('div');
  empty.className = 'muted';
  empty.style.padding = '20px';
  empty.style.textAlign = 'center';
  empty.textContent = '暂无已配置的 MCP 服务器。';
  return empty;
}

function createMcpServersTableElement(servers) {
  const wrapper = document.createElement('div');
  wrapper.className = 'route-table';
  const head = document.createElement('div');
  head.className = 'route-table-head';
  const headTable = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  [
    ['服务器 ID', ''],
    ['URL (HTTP/SSE)', ''],
    ['前缀', ''],
    ['Bearer Token', '180px'],
    ['注入', '60px'],
    ['操作', '150px'],
  ].forEach(([label, width]) => {
    const th = document.createElement('th');
    th.textContent = label;
    if (width) th.style.width = width;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  headTable.appendChild(thead);
  head.appendChild(headTable);

  const scroll = document.createElement('div');
  scroll.className = 'route-table-scroll';
  const bodyTable = document.createElement('table');
  const tbody = document.createElement('tbody');
  servers.forEach((server, index) => {
    tbody.appendChild(createMcpServerRow(server, index));
    tbody.appendChild(createMcpServerToolsRow(server, index));
  });
  bodyTable.appendChild(tbody);
  scroll.appendChild(bodyTable);
  wrapper.append(head, scroll);
  return wrapper;
}

function createMcpServerInput(server, index, field, placeholder = '') {
  const input = document.createElement('input');
  input.type = field === 'bearerToken' ? 'password' : 'text';
  input.value = String(server[field] || '');
  input.className = 'table-input';
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener('change', () => updateMcpServer(index, field, input.value));
  return input;
}

function createMcpServerRow(server, index) {
  const row = document.createElement('tr');

  const idCell = document.createElement('td');
  idCell.appendChild(createMcpServerInput(server, index, 'id'));
  row.appendChild(idCell);

  const urlCell = document.createElement('td');
  urlCell.appendChild(createMcpServerInput(server, index, 'url', 'http://...'));
  row.appendChild(urlCell);

  const prefixCell = document.createElement('td');
  prefixCell.appendChild(createMcpServerInput(server, index, 'prefix', '可选'));
  row.appendChild(prefixCell);

  const tokenCell = document.createElement('td');
  tokenCell.appendChild(createMcpServerInput(server, index, 'bearerToken', 'GLM Coding Plan Key'));
  row.appendChild(tokenCell);

  const injectCell = document.createElement('td');
  injectCell.style.textAlign = 'center';
  const injectCheckbox = document.createElement('input');
  injectCheckbox.type = 'checkbox';
  injectCheckbox.checked = Boolean(server.injectAll);
  injectCheckbox.addEventListener('change', () =>
    updateMcpServer(index, 'injectAll', injectCheckbox.checked)
  );
  injectCell.appendChild(injectCheckbox);
  row.appendChild(injectCell);

  const actionCell = document.createElement('td');
  actionCell.style.textAlign = 'right';
  actionCell.style.whiteSpace = 'nowrap';

  const probeButton = document.createElement('button');
  probeButton.className = 'light';
  probeButton.style.padding = '2px 8px';
  probeButton.style.fontSize = '12px';
  probeButton.style.margin = '0 4px 0 0';
  probeButton.textContent = '探测工具';
  probeButton.addEventListener('click', async () => {
    probeButton.disabled = true;
    probeButton.textContent = '探测中...';
    try {
      const res = await window.proxyManager.mcpToolsList(server.id);
      if (res && res.ok) {
        serverToolsCache.set(server.id, res.tools || []);
        mcpDependencies.showToast(`成功拉取 ${res.tools?.length || 0} 个 MCP 工具`, 'success');
      } else {
        serverToolsCache.set(server.id, []);
        mcpDependencies.showToast(`探测工具失败: ${res?.error || '未知错误'}`, 'error');
      }
      renderMcpServers();
    } catch (err) {
      mcpDependencies.showToast(`探测异常: ${err.message}`, 'error');
    } finally {
      probeButton.disabled = false;
      probeButton.textContent = '探测工具';
    }
  });
  actionCell.appendChild(probeButton);

  const deleteButton = document.createElement('button');
  deleteButton.className = 'danger';
  deleteButton.style.padding = '2px 8px';
  deleteButton.style.fontSize = '12px';
  deleteButton.style.margin = '0';
  deleteButton.textContent = '删除';
  deleteButton.addEventListener('click', () => deleteMcpServer(index));
  actionCell.appendChild(deleteButton);
  row.appendChild(actionCell);

  return row;
}

const serverToolsCache = new Map();

function createMcpServerToolsRow(server, index) {
  const tr = document.createElement('tr');
  tr.id = `mcp-tools-row-${server.id || index}`;
  tr.className = 'mcp-tools-expand-row';
  const td = document.createElement('td');
  td.colSpan = 6;
  td.style.padding = '8px 14px';
  td.style.background = 'var(--card-highlight, rgba(0, 0, 0, 0.02))';
  td.style.borderBottom = '1px solid var(--border)';
  td.style.fontSize = '12px';

  const tools = serverToolsCache.get(server.id);
  if (!tools) {
    td.className = 'muted';
    td.textContent = '点击“探测工具”以获取此服务器的可用 Tools 与 Schema。';
  } else if (tools.length === 0) {
    td.className = 'muted';
    td.textContent = '未探测到可用工具。';
  } else {
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.flexWrap = 'wrap';
    container.style.gap = '6px';

    const label = document.createElement('span');
    label.style.fontWeight = '600';
    label.style.color = 'var(--text)';
    label.textContent = `可用工具 (${tools.length})：`;
    container.appendChild(label);

    tools.forEach((tool) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'light';
      btn.style.padding = '2px 8px';
      btn.style.fontSize = '11px';
      btn.style.margin = '0';
      btn.style.borderRadius = '4px';
      btn.style.fontFamily = 'var(--font-mono)';
      btn.title = tool.description || '点击在线测试此工具';
      const iconSpan = document.createElement('span');
      iconSpan.textContent = '⚡ ';
      const strongName = document.createElement('strong');
      strongName.textContent = tool.name;
      btn.append(iconSpan, strongName);
      btn.onclick = () => openMcpToolRunnerModal(server, tool);
      container.appendChild(btn);
    });
    td.appendChild(container);
  }
  tr.appendChild(td);
  return tr;
}

function generateSampleArgs(schema) {
  if (!schema || typeof schema !== 'object' || !schema.properties) {
    return {};
  }
  const sample = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.default !== undefined) {
      sample[key] = prop.default;
    } else if (prop.type === 'string') {
      sample[key] = prop.description ? '<' + prop.description + '>' : '';
    } else if (prop.type === 'number' || prop.type === 'integer') {
      sample[key] = 0;
    } else if (prop.type === 'boolean') {
      sample[key] = false;
    } else if (prop.type === 'array') {
      sample[key] = [];
    } else if (prop.type === 'object') {
      sample[key] = {};
    } else {
      sample[key] = '';
    }
  }
  return sample;
}

function openMcpToolRunnerModal(server, tool) {
  let modalBackdrop = document.getElementById('mcpToolRunnerModalBackdrop');
  if (!modalBackdrop) {
    modalBackdrop = document.createElement('div');
    modalBackdrop.id = 'mcpToolRunnerModalBackdrop';
    modalBackdrop.className = 'modal-backdrop';
    document.body.appendChild(modalBackdrop);
  }
  mcpDependencies.clearElement(modalBackdrop);

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.width = 'min(580px, 94%)';
  modal.style.maxHeight = '85vh';
  modal.style.overflowY = 'auto';

  const title = document.createElement('h3');
  title.textContent = `⚡ MCP 工具试运行 · ${tool.name}`;
  modal.appendChild(title);

  const serverInfo = document.createElement('p');
  serverInfo.style.fontSize = '12px';
  serverInfo.style.marginBottom = '6px';
  const serverCode = document.createElement('code');
  serverCode.textContent = server.id;
  serverInfo.append('所属服务：', serverCode, server.url ? ` (${server.url})` : '');
  modal.appendChild(serverInfo);

  if (tool.description) {
    const desc = document.createElement('p');
    desc.style.fontSize = '12.5px';
    desc.style.color = 'var(--text)';
    desc.style.marginBottom = '12px';
    desc.style.padding = '8px 10px';
    desc.style.background = 'var(--card-highlight, rgba(0,0,0,0.03))';
    desc.style.borderRadius = '6px';
    desc.textContent = tool.description;
    modal.appendChild(desc);
  }

  const labelArgs = document.createElement('label');
  labelArgs.style.display = 'block';
  labelArgs.style.fontSize = '12px';
  labelArgs.style.fontWeight = '600';
  labelArgs.style.marginBottom = '4px';
  labelArgs.textContent = '工具输入参数 (JSON Arguments):';
  modal.appendChild(labelArgs);

  const argsInput = document.createElement('textarea');
  argsInput.className = 'table-input';
  argsInput.style.width = '100%';
  argsInput.style.minHeight = '110px';
  argsInput.style.fontFamily = 'var(--font-mono)';
  argsInput.style.fontSize = '12px';
  argsInput.style.padding = '8px';
  argsInput.style.boxSizing = 'border-box';
  argsInput.value = JSON.stringify(generateSampleArgs(tool.inputSchema), null, 2);
  modal.appendChild(argsInput);

  const resultBox = document.createElement('div');
  resultBox.style.display = 'none';
  resultBox.style.marginTop = '12px';
  resultBox.style.padding = '10px';
  resultBox.style.borderRadius = '6px';
  resultBox.style.background = '#0f172a';
  resultBox.style.color = '#e2e8f0';
  resultBox.style.fontFamily = 'var(--font-mono)';
  resultBox.style.fontSize = '12px';
  resultBox.style.maxHeight = '200px';
  resultBox.style.overflowY = 'auto';
  resultBox.style.whiteSpace = 'pre-wrap';
  resultBox.style.wordBreak = 'break-all';
  modal.appendChild(resultBox);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'light';
  closeBtn.textContent = '关闭';
  closeBtn.onclick = () => {
    modalBackdrop.classList.remove('active');
  };

  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.textContent = '执行调用';
  runBtn.onclick = async () => {
    let parsedArgs = {};
    try {
      const trimmed = argsInput.value.trim();
      if (trimmed) parsedArgs = JSON.parse(trimmed);
    } catch (err) {
      mcpDependencies.showToast('参数不是合法的 JSON 格式：' + err.message, 'error');
      return;
    }
    runBtn.disabled = true;
    runBtn.textContent = '调用中...';
    resultBox.style.display = 'block';
    resultBox.textContent = '正在发送请求到 MCP 远端服务...';

    try {
      const res = await window.proxyManager.mcpExecuteTool({
        serverId: server.id,
        toolName: tool.name,
        arguments: parsedArgs,
      });
      if (res && res.ok) {
        resultBox.textContent =
          `[执行成功 - 耗时 ${res.elapsedMs || 0}ms]\n` + JSON.stringify(res.result, null, 2);
        mcpDependencies.showToast(`执行成功 (${res.elapsedMs}ms)`, 'success');
      } else {
        resultBox.textContent =
          `[执行失败 - 耗时 ${res?.elapsedMs || 0}ms]\n错误：` + (res?.error || '未知错误');
        mcpDependencies.showToast(`执行失败: ${res?.error || '未知错误'}`, 'error');
      }
      refreshMcpHub();
    } catch (err) {
      resultBox.textContent = `[请求异常]\n${err.message}`;
      mcpDependencies.showToast(`请求异常: ${err.message}`, 'error');
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = '再次执行';
    }
  };

  actions.append(closeBtn, runBtn);
  modal.appendChild(actions);
  modalBackdrop.appendChild(modal);
  modalBackdrop.classList.add('active');
}

function updateMcpServer(index, field, value) {
  if (mcpHubConfig.servers[index]) {
    mcpHubConfig.servers[index][field] = value;
  }
}

function deleteMcpServer(index) {
  mcpHubConfig.servers.splice(index, 1);
  renderMcpServers();
}

function addMcpServer() {
  if (!mcpHubConfig.servers) mcpHubConfig.servers = [];
  mcpHubConfig.servers.push({
    id: 'mcp-server-' + Math.random().toString(36).substring(2, 6),
    url: 'http://localhost:3000/sse',
    prefix: '',
    injectAll: true,
  });
  renderMcpServers();
}

function addGlmSearchMcpServer() {
  if (!mcpHubConfig.servers) mcpHubConfig.servers = [];
  if (!mcpHubConfig.routing) mcpHubConfig.routing = [];

  const template = GLM_MCP_TEMPLATES.webSearchPrime;
  const existing = mcpHubConfig.servers.find((server) => server && server.id === template.id);
  if (existing) {
    Object.assign(existing, {
      url: template.url,
      prefix: existing.prefix || template.prefix,
      injectAll: true,
    });
  } else {
    mcpHubConfig.servers.push({
      ...template,
      bearerToken: '',
    });
  }

  const hasRoute = mcpHubConfig.routing.some(
    (route) => route && route.serverId === template.id && route.pattern === '^glm_search_'
  );
  if (!hasRoute) {
    mcpHubConfig.routing.push({ pattern: '^glm_search_', serverId: template.id });
  }
  renderMcpServers();
  const status = mcpDependencies.$('mcpHubStatus');
  if (status) {
    status.textContent =
      '已添加 GLM 联网搜索 MCP 模板。请在 Bearer Token 中填入 GLM Coding Plan API Key 后保存。';
  }
}

function createMcpLogsEmptyElement() {
  const empty = document.createElement('div');
  empty.className = 'muted';
  empty.textContent = '暂无执行记录...';
  return empty;
}

function createMcpLogEntryElement(log) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.style.marginBottom = '12px';
  entry.style.borderBottom = '1px solid var(--border)';
  entry.style.paddingBottom = '8px';

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';

  const title = document.createElement('div');
  const time = document.createElement('span');
  time.className = 'muted';
  time.textContent = `[${new Date(log.time).toLocaleTimeString()}] `;
  title.appendChild(time);

  const server = document.createElement('strong');
  server.style.color = 'var(--text)';
  server.textContent = log.serverId || '-';
  title.appendChild(server);
  title.appendChild(document.createTextNode(': '));

  const tool = document.createElement('code');
  tool.style.color = 'var(--primary)';
  tool.style.fontWeight = '600';
  tool.textContent = log.toolName || '-';
  title.appendChild(tool);

  const badge = document.createElement('span');
  badge.className = `badge ${log.status === 'error' ? 'red' : 'green'}`;
  badge.textContent = `${log.status === 'error' ? '失败' : '成功'} (${log.elapsed || 0}ms)`;

  header.appendChild(title);
  header.appendChild(badge);
  entry.appendChild(header);

  const metadata = document.createElement('div');
  metadata.className = 'muted';
  metadata.style.marginTop = '4px';
  const inputBytes = Number.isFinite(Number(log.inputBytes)) ? Number(log.inputBytes) : 0;
  const resultBytes = Number.isFinite(Number(log.resultBytes)) ? Number(log.resultBytes) : 0;
  const errorType = log.errorType ? ` · 错误类型 ${log.errorType}` : '';
  metadata.textContent = `输入 ${inputBytes} B · 输出 ${resultBytes} B${errorType}`;
  entry.appendChild(metadata);
  return entry;
}

function renderMcpLogs(logs) {
  const container = mcpDependencies.$('mcpExecutionLogs');
  container.textContent = '';
  if (!logs || logs.length === 0) {
    container.appendChild(createMcpLogsEmptyElement());
    return;
  }

  logs.forEach((log) => container.appendChild(createMcpLogEntryElement(log)));
}

async function saveMcpHub() {
  const btn = mcpDependencies.$('saveMcpHub');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在保存...';

  try {
    const res = await window.proxyManager.mcpHubSave({ mcpHub: mcpHubConfig });
    if (res.ok) {
      mcpDependencies.showToast('MCP 配置已保存', 'success');
      refreshMcpHub();
    } else {
      mcpDependencies.showToast('保存失败：' + (res.error || '未知错误'), 'error');
    }
  } catch (err) {
    mcpDependencies.showToast('保存出错：' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

export { initMcpHubView };
