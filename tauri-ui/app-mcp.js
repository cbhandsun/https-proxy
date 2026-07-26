// Extracted domain module. Loaded before app.js; functions resolve shared globals at call time.

// --- MCP Hub UI Logic ---

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
  const container = $('mcpHubView');
  if (!container || container.dataset.initialized) {
    refreshMcpHub();
    return;
  }
  container.dataset.initialized = 'true';

  $('refreshMcpHub').onclick = () => refreshMcpHub();
  $('addMcpServer').onclick = () => addMcpServer();
  const addGlmSearchButton = $('addGlmSearchMcpServer');
  if (addGlmSearchButton) addGlmSearchButton.onclick = () => addGlmSearchMcpServer();
  $('saveMcpHub').onclick = () => saveMcpHub();

  refreshMcpHub();
}

async function refreshMcpHub() {
  const status = $('mcpHubStatus');
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
  const container = $('mcpServersList');
  clearElement(container);
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
    ['操作', '80px'],
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
  servers.forEach((server, index) => tbody.appendChild(createMcpServerRow(server, index)));
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
  const status = $('mcpHubStatus');
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
  const container = $('mcpExecutionLogs');
  container.textContent = '';
  if (!logs || logs.length === 0) {
    container.appendChild(createMcpLogsEmptyElement());
    return;
  }

  logs.forEach((log) => container.appendChild(createMcpLogEntryElement(log)));
}

async function saveMcpHub() {
  const btn = $('saveMcpHub');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在保存...';

  try {
    const res = await window.proxyManager.mcpHubSave({ mcpHub: mcpHubConfig });
    if (res.ok) {
      showToast('MCP 配置已保存', 'success');
      refreshMcpHub();
    } else {
      showToast('保存失败：' + (res.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('保存出错：' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}
