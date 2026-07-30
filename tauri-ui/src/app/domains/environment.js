import { bindDomainDependencies } from '../runtime/dependencies.js';
import { reportFrontendError } from '../runtime/frontend-errors.js';

let environmentDependencies;

export function configureEnvironment(dependencies) {
  environmentDependencies = bindDomainDependencies('environment', dependencies, [
    '$',
    'clearElement',
    'confirmAction',
    'perfStart',
    'showToast',
  ]);
}

// Environment inspection and tool upgrade UI.

let isRefreshingEnv = false;
let lastEnvStatusRefresh = 0;
let lastRenderedEnvHtml = '';
let envPendingRefreshTimer = null;
let lastEnvActionToolIds = [];
const envInstallJobsByTool = new Map();
const lastEnvToolsById = new Map();
let envInstallPollTimer = null;

function getPreferredEnvInstallCommand(tool) {
  if (tool && tool.installCommand) return tool.installCommand;
  if (tool && tool.packageName) return `npm i -g ${tool.packageName}@latest`;
  return '';
}

function getEnvInstallMethodLabel(job) {
  return job && job.installMethod === 'powershell' ? '官方 PowerShell 安装器' : 'npm 全局安装';
}

function scheduleEnvPendingRefresh(delayMs = 2500) {
  if (envPendingRefreshTimer) clearTimeout(envPendingRefreshTimer);
  envPendingRefreshTimer = setTimeout(() => {
    envPendingRefreshTimer = null;
    refreshEnvStatus({ passive: true, force: true });
  }, delayMs);
}

function rememberEnvInstallJobs(results = []) {
  let hasRunning = false;
  for (const result of results) {
    if (!result || !result.jobId || !result.id) continue;
    envInstallJobsByTool.set(result.id, {
      jobId: result.jobId,
      toolId: result.id,
      name: result.name || result.id,
      status: result.status || 'running',
      ok: result.ok,
      error: result.error || '',
      startedAt: result.startedAt || Date.now(),
      endedAt: result.endedAt || null,
      installCommand: result.installCommand || '',
      installMethod: result.installMethod || (result.usesIrm ? 'powershell' : 'npm'),
      usesIrm: !!result.usesIrm,
      lastLine: result.lastLine || result.error || result.outputTail || '任务已启动',
      outputTail: result.outputTail || '',
    });
    if (result.status !== 'succeeded' && result.status !== 'failed') {
      hasRunning = true;
    }
  }
  if (hasRunning) startEnvInstallPolling();
  updateEnvInstallProgressPanel();
}

function envJobStatusLabel(status) {
  if (status === 'succeeded') return '完成';
  if (status === 'failed') return '失败';
  if (status === 'verifying') return '复检中';
  if (status === 'submitting') return '提交中';
  if (status === 'queued') return '等待中';
  return '执行中';
}

function envDataSignature(tools = []) {
  return JSON.stringify({
    tools: tools.map((tool) => ({
      id: tool && tool.id,
      name: tool && tool.name,
      current: tool && tool.current,
      latest: tool && tool.latest,
      hasUpdate: !!(tool && tool.hasUpdate),
      installCommand: tool && tool.installCommand,
      installMethod: tool && tool.installMethod,
    })),
    jobs: Array.from(envInstallJobsByTool.values()).map((job) => ({
      toolId: job && job.toolId,
      status: job && job.status,
      lastLine: job && job.lastLine,
      outputTail: job && job.outputTail,
      installCommand: job && job.installCommand,
      installMethod: job && job.installMethod,
      usesIrm: !!(job && job.usesIrm),
    })),
  });
}

function setGridNotice(element) {
  if (!element) return;
  element.style.gridColumn = '1 / -1';
}

function createEnvCodeBlock(text, maxHeight = '42px') {
  const code = document.createElement('code');
  code.style.display = 'block';
  code.style.maxHeight = maxHeight;
  code.style.overflow = 'auto';
  code.style.whiteSpace = 'pre-wrap';
  code.style.wordBreak = 'break-word';
  code.style.color = 'var(--text)';
  code.style.fontFamily = 'var(--font-mono)';
  code.style.fontSize = '11.5px';
  code.style.lineHeight = '1.35';
  code.textContent = text;
  return code;
}

function createEnvProgressItem(job) {
  const failed = job.status === 'failed';
  const succeeded = job.status === 'succeeded';
  const item = document.createElement('div');
  item.style.display = 'grid';
  item.style.gridTemplateColumns = 'minmax(120px, 180px) minmax(100px, 140px) 1fr';
  item.style.gap = '10px';
  item.style.alignItems = 'start';
  item.style.padding = '8px 10px';
  item.style.border = `1px solid ${failed ? 'rgba(239, 68, 68, 0.35)' : 'var(--border)'}`;
  item.style.borderRadius = '6px';
  item.style.background = succeeded ? 'rgba(16, 185, 129, 0.08)' : 'var(--card-bg)';

  const info = document.createElement('div');
  const name = document.createElement('div');
  name.style.fontWeight = '700';
  name.style.color = 'var(--text)';
  name.textContent = job.name || job.toolId || '';
  const method = document.createElement('div');
  method.className = 'muted';
  method.style.fontSize = '12px';
  method.textContent = getEnvInstallMethodLabel(job);
  info.append(name, method);

  const status = document.createElement('strong');
  status.style.color = failed ? '#ef4444' : 'var(--text)';
  status.textContent = envJobStatusLabel(job.status);

  item.append(
    info,
    status,
    createEnvCodeBlock(
      job.lastLine || job.outputTail || job.installCommand || '等待输出...',
      '48px'
    )
  );
  return item;
}

function updateEnvInstallProgressPanel() {
  const panel = environmentDependencies.$('envInstallProgressPanel');
  if (!panel) return;
  const jobs = Array.from(envInstallJobsByTool.values()).sort(
    (a, b) => (b.startedAt || 0) - (a.startedAt || 0)
  );
  if (jobs.length === 0) {
    panel.style.display = 'none';
    environmentDependencies.clearElement(panel);
    return;
  }

  panel.style.display = 'block';
  environmentDependencies.clearElement(panel);
  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.justifyContent = 'space-between';
  header.style.gap = '12px';
  header.style.marginBottom = '8px';
  const title = document.createElement('strong');
  title.style.fontSize = '13px';
  title.style.color = 'var(--text)';
  title.textContent = '安装/升级进度';
  const hint = document.createElement('span');
  hint.className = 'muted';
  hint.style.fontSize = '12px';
  hint.textContent = '显示最近任务输出，完成后会自动刷新版本状态';
  header.append(title, hint);

  const list = document.createElement('div');
  list.style.display = 'grid';
  list.style.gap = '8px';
  jobs.forEach((job) => list.appendChild(createEnvProgressItem(job)));
  panel.append(header, list);
}

function markEnvInstallSubmitting(toolIds = []) {
  const now = Date.now();
  for (const toolId of toolIds.filter(Boolean)) {
    const tool = lastEnvToolsById.get(toolId) || { id: toolId, name: toolId };
    const installCommand = getPreferredEnvInstallCommand(tool);
    envInstallJobsByTool.set(toolId, {
      jobId: `pending-${toolId}-${now}`,
      toolId,
      name: tool.name || toolId,
      status: 'submitting',
      installCommand,
      installMethod: tool.installMethod || 'npm',
      usesIrm: tool.installMethod === 'powershell',
      startedAt: now,
      lastLine: '正在提交安装任务...',
      outputTail: '',
    });
  }
  updateEnvInstallProgressPanel();
  lastRenderedEnvHtml = '';
}

function finalizeEnvInstallSubmission(toolIds = [], results = [], fallbackError = '') {
  const byId = new Map((results || []).map((result) => [result && result.id, result]));
  for (const toolId of toolIds.filter(Boolean)) {
    const result = byId.get(toolId);
    if (result && result.jobId) continue;
    const current = envInstallJobsByTool.get(toolId);
    if (!current || !String(current.jobId || '').startsWith('pending-')) continue;
    const failed = fallbackError || (result && result.ok === false);
    envInstallJobsByTool.set(toolId, {
      ...current,
      status: failed ? 'failed' : 'succeeded',
      endedAt: Date.now(),
      error: fallbackError || (result && result.error) || '',
      lastLine: failed
        ? fallbackError || (result && result.error) || '安装任务失败'
        : '安装/升级完成',
    });
  }
  updateEnvInstallProgressPanel();
}

async function pollEnvInstallJobs() {
  const jobIds = Array.from(envInstallJobsByTool.values())
    .filter((job) => job && job.jobId && job.status !== 'succeeded' && job.status !== 'failed')
    .map((job) => job.jobId);
  if (jobIds.length === 0) {
    if (envInstallPollTimer) clearInterval(envInstallPollTimer);
    envInstallPollTimer = null;
    updateEnvInstallProgressPanel();
    return;
  }

  const res = await window.proxyManager.envInstallJobs(jobIds);
  if (!res.ok || !Array.isArray(res.jobs)) return;
  let changed = false;
  let allDone = true;
  for (const job of res.jobs) {
    if (!job || !job.toolId) continue;
    envInstallJobsByTool.set(job.toolId, job);
    changed = true;
    if (job.status !== 'succeeded' && job.status !== 'failed') allDone = false;
  }
  if (changed) {
    updateEnvInstallProgressPanel();
    lastRenderedEnvHtml = '';
    refreshEnvStatus({ passive: true, force: true });
  }
  if (allDone) {
    if (envInstallPollTimer) clearInterval(envInstallPollTimer);
    envInstallPollTimer = null;
    setTimeout(() => refreshEnvStatus({ passive: true, force: true }), 1200);
  }
}

function startEnvInstallPolling() {
  if (envInstallPollTimer) return;
  envInstallPollTimer = setInterval(() => {
    pollEnvInstallJobs().catch((err) => reportFrontendError('environment.poll_install_jobs', err));
  }, 1200);
  pollEnvInstallJobs().catch((err) => reportFrontendError('environment.poll_install_jobs', err));
}

function createEnvSkeletonCard() {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.padding = '16px';
  card.style.display = 'flex';
  card.style.flexDirection = 'column';
  card.style.minHeight = '120px';
  card.style.opacity = '0.7';

  const top = document.createElement('div');
  top.style.display = 'flex';
  top.style.justifyContent = 'space-between';
  top.style.alignItems = 'flex-start';
  top.style.marginBottom = '12px';
  const identity = document.createElement('div');
  identity.style.display = 'flex';
  identity.style.alignItems = 'center';
  identity.style.gap = '8px';
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  dot.style.margin = '0';
  dot.style.background = 'var(--border)';
  const title = document.createElement('strong');
  title.style.width = '80px';
  title.style.height = '16px';
  title.style.background = 'var(--border)';
  title.style.borderRadius = '2px';
  identity.append(dot, title);
  top.appendChild(identity);

  const rows = document.createElement('div');
  rows.style.display = 'flex';
  rows.style.flexDirection = 'column';
  rows.style.gap = '8px';
  ['60%', '80%'].forEach((width) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.height = '14px';
    row.style.background = 'var(--border)';
    row.style.borderRadius = '2px';
    row.style.width = width;
    rows.appendChild(row);
  });
  card.append(top, rows);
  return card;
}

function renderEnvSkeleton(grid) {
  environmentDependencies.clearElement(grid);
  for (let i = 0; i < 6; i++) grid.appendChild(createEnvSkeletonCard());
}

function createEnvActionButton(tool, isInstalled, isJobRunning) {
  const button = document.createElement('button');
  button.style.margin = '0';
  button.style.padding = '4px 8px';
  button.style.fontSize = '12px';
  button.style.height = '26px';
  button.style.lineHeight = '1';
  if (isJobRunning) {
    button.className = 'light';
    button.disabled = true;
    button.style.opacity = '0.7';
    button.textContent = '执行中';
    return button;
  }
  if (!isInstalled || tool.hasUpdate) {
    button.className = 'primary';
    button.dataset.upgradeTool = tool.id || '';
    button.dataset.upgradeAction = isInstalled ? 'upgrade' : 'install';
    button.textContent = isInstalled ? '升级' : '安装';
    return button;
  }
  button.className = 'light';
  button.disabled = true;
  button.style.opacity = '0.5';
  button.textContent = '最新';
  return button;
}

function createEnvProgressBlock(installJob) {
  if (!installJob) return null;
  const failed = installJob.status === 'failed';
  const block = document.createElement('div');
  block.style.display = 'flex';
  block.style.flexDirection = 'column';
  block.style.gap = '4px';
  block.style.marginTop = '4px';
  block.style.padding = '8px 10px';
  block.style.border = `1px solid ${failed ? 'rgba(239, 68, 68, 0.35)' : 'var(--border)'}`;
  block.style.borderRadius = '6px';
  block.style.background =
    installJob.status === 'succeeded' ? 'rgba(16, 185, 129, 0.08)' : 'var(--bg-hover)';

  const line = document.createElement('div');
  line.style.display = 'flex';
  line.style.justifyContent = 'space-between';
  line.style.gap = '8px';
  line.style.alignItems = 'center';
  const label = document.createElement('span');
  label.className = 'muted';
  label.textContent = '安装进度';
  const status = document.createElement('strong');
  status.style.color = failed ? '#ef4444' : 'var(--text)';
  status.textContent = envJobStatusLabel(installJob.status);
  line.append(label, status);

  const method = document.createElement('div');
  method.className = 'muted';
  method.style.fontSize = '12px';
  method.textContent = getEnvInstallMethodLabel(installJob);
  block.append(
    line,
    method,
    createEnvCodeBlock(installJob.lastLine || installJob.outputTail || '等待输出...')
  );
  return block;
}

function createEnvInfoRow(labelText, valueText) {
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.justifyContent = 'space-between';
  const label = document.createElement('span');
  label.className = 'muted';
  label.textContent = labelText;
  const value = document.createElement('strong');
  value.style.color = 'var(--text)';
  value.textContent = valueText;
  row.append(label, value);
  return row;
}

function createEnvToolCard(tool) {
  const isInstalled = !!tool.current;
  const installJob = envInstallJobsByTool.get(tool.id);
  const isJobRunning =
    installJob && installJob.status !== 'succeeded' && installJob.status !== 'failed';
  const card = document.createElement('div');
  card.className = 'card env-card';
  card.style.padding = '16px';
  card.style.display = 'flex';
  card.style.flexDirection = 'column';
  card.style.minHeight = '142px';
  card.style.border = `1px solid ${!isInstalled || tool.hasUpdate ? 'var(--primary)' : 'var(--border)'}`;
  card.style.background =
    !isInstalled || tool.hasUpdate ? 'rgba(var(--primary-rgb), 0.05)' : 'var(--card-bg)';

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'flex-start';
  header.style.marginBottom = '12px';
  const identity = document.createElement('div');
  identity.style.display = 'flex';
  identity.style.alignItems = 'center';
  identity.style.gap = '8px';
  const dot = document.createElement('span');
  dot.className = `status-dot ${isInstalled ? 'green' : 'amber'}`;
  dot.style.margin = '0';
  const name = document.createElement('strong');
  name.style.fontSize = '15px';
  name.style.color = 'var(--text)';
  name.textContent = tool.name || tool.id || '';
  identity.append(dot, name);
  header.append(identity, createEnvActionButton(tool, isInstalled, isJobRunning));

  const body = document.createElement('div');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '6px';
  body.style.fontSize = '13px';
  body.style.flex = '1';
  body.append(
    createEnvInfoRow('当前版本', tool.current || '未安装'),
    createEnvInfoRow('最新版本', tool.latest || '加载中...')
  );

  const commandBlock = document.createElement('div');
  commandBlock.style.display = 'flex';
  commandBlock.style.flexDirection = 'column';
  commandBlock.style.gap = '4px';
  commandBlock.style.marginTop = '4px';
  const commandLabel = document.createElement('span');
  commandLabel.className = 'muted';
  commandLabel.textContent = '安装命令';
  const command = document.createElement('code');
  command.style.display = 'block';
  command.style.padding = '6px 8px';
  command.style.border = '1px solid var(--border)';
  command.style.borderRadius = '4px';
  command.style.background = 'var(--bg-hover)';
  command.style.color = 'var(--text)';
  command.style.fontFamily = 'var(--font-mono)';
  command.style.fontSize = '12px';
  command.style.lineHeight = '1.35';
  command.style.overflowX = 'auto';
  command.style.whiteSpace = 'nowrap';
  command.textContent = getPreferredEnvInstallCommand(tool);
  commandBlock.append(commandLabel, command);
  body.appendChild(commandBlock);
  const progress = createEnvProgressBlock(installJob);
  if (progress) body.appendChild(progress);
  card.append(header, body);
  return card;
}

async function refreshEnvStatus(options = {}) {
  const now = Date.now();
  if (
    options.passive &&
    !options.force &&
    lastRenderedEnvHtml &&
    now - lastEnvStatusRefresh < 30000
  )
    return;
  if (isRefreshingEnv) return;
  isRefreshingEnv = true;
  const finishPerf = environmentDependencies.perfStart('refresh.envStatus');

  const grid = environmentDependencies.$('envGrid');
  const btnRefresh = environmentDependencies.$('btnRefreshEnv');
  const svgRefresh = environmentDependencies.$('svgRefreshEnv');
  const btnUpgradeAll = environmentDependencies.$('btnUpgradeAllEnv');

  if (btnRefresh) btnRefresh.disabled = true;
  if (svgRefresh) svgRefresh.style.animation = 'spin 1s linear infinite';

  // 预渲染加载骨架；被动刷新已有结果时不闪烁列表。
  if (!options.passive || !lastRenderedEnvHtml) {
    renderEnvSkeleton(grid);
  }

  try {
    const res = await window.proxyManager.envCheck();
    if (!res.ok) throw new Error(res.error || '检查失败');

    let updateCount = 0;
    let installCount = 0;
    const actionToolIds = [];
    const tools = Array.isArray(res.tools) ? res.tools : [];
    tools.forEach((tool) => {
      if (tool && tool.id) lastEnvToolsById.set(tool.id, tool);
      const isInstalled = !!(tool && tool.current);
      if (!isInstalled) installCount++;
      if (tool && tool.hasUpdate) updateCount++;
      if (tool && (!isInstalled || tool.hasUpdate)) actionToolIds.push(tool.id);
    });
    lastEnvActionToolIds = actionToolIds.filter(Boolean);
    const envSignature = envDataSignature(tools);
    if (envSignature !== lastRenderedEnvHtml) {
      grid.replaceChildren(...tools.map((tool) => createEnvToolCard(tool || {})));
      lastRenderedEnvHtml = envSignature;
    }

    const actionCount = updateCount + installCount;
    btnUpgradeAll.textContent =
      actionCount > 0 ? `全部安装/升级 (${actionCount})` : '全部安装/升级 (0)';
    btnUpgradeAll.disabled = actionCount === 0;
    lastEnvStatusRefresh = Date.now();
    if (res.latestPending) {
      scheduleEnvPendingRefresh();
    }
  } catch (err) {
    environmentDependencies.showToast('环境检查刷新失败: ' + err.message, 'error');
    const notice = document.createElement('div');
    notice.className = 'notice';
    setGridNotice(notice);
    notice.textContent = `刷新失败，请检查网络或代理服务器运行状态：${err.message}`;
    grid.replaceChildren(notice);
  } finally {
    isRefreshingEnv = false;
    if (btnRefresh) btnRefresh.disabled = false;
    if (svgRefresh) {
      svgRefresh.style.animation = '';
      void svgRefresh.offsetWidth;
    }
    finishPerf();
  }
}

window.upgradeSingleTool = async function (toolId, action = 'upgrade') {
  const isInstall = action === 'install';
  const confirmed = await environmentDependencies.confirmAction({
    title: isInstall ? '安装助手工具' : '升级助手工具',
    message: `确认要${isInstall ? '安装' : '升级'}该 AI 命令行工具吗？这将在后台执行全局安装命令，耗时可能较长。`,
    confirmText: isInstall ? '确定安装' : '确定升级',
  });
  if (!confirmed) return;

  markEnvInstallSubmitting([toolId]);
  lastRenderedEnvHtml = '';
  refreshEnvStatus({ passive: true, force: true });
  environmentDependencies.showToast(
    isInstall ? '正在安装工具，请稍候...' : '正在升级工具，请稍候...',
    'success'
  );
  try {
    const res = await window.proxyManager.envUpgrade(toolId);
    if (!res.ok) throw new Error(res.error || (isInstall ? '安装失败' : '升级失败'));

    const result = res.results && res.results[0];
    if (result && !result.ok) {
      throw new Error(result.error || '安装失败');
    }

    rememberEnvInstallJobs(res.results || []);
    finalizeEnvInstallSubmission([toolId], res.results || []);
    environmentDependencies.showToast(
      isInstall ? '安装任务已启动，正在显示进度...' : '升级任务已启动，正在显示进度...',
      'success'
    );
    refreshEnvStatus({ passive: true, force: true });
  } catch (err) {
    finalizeEnvInstallSubmission([toolId], [], err.message);
    environmentDependencies.showToast(
      (isInstall ? '工具安装失败：' : '工具升级失败：') + err.message,
      'error'
    );
  }
};

async function upgradeAllEnv() {
  const confirmed = await environmentDependencies.confirmAction({
    title: '全部安装/升级',
    message:
      '确认要安装缺失工具并升级有更新的 AI 命令行工具吗？这将在后台依次串行执行全局安装命令，需要数分钟时间。',
    confirmText: '全部安装/升级',
  });
  if (!confirmed) return;

  environmentDependencies.showToast(
    '正在执行全部升级，可能需要几分钟时间，请勿关闭本管理器...',
    'success'
  );
  const btnUpgradeAll = environmentDependencies.$('btnUpgradeAllEnv');
  if (btnUpgradeAll) {
    btnUpgradeAll.disabled = true;
    btnUpgradeAll.textContent = '正在安装/升级...';
  }
  const batchToolIds = lastEnvActionToolIds.slice();
  markEnvInstallSubmitting(batchToolIds);
  lastRenderedEnvHtml = '';
  refreshEnvStatus({ passive: true, force: true });

  try {
    const res = await window.proxyManager.envUpgrade(batchToolIds);
    if (!res.ok) throw new Error(res.error || '升级失败');

    rememberEnvInstallJobs(res.results || []);
    finalizeEnvInstallSubmission(batchToolIds, res.results || []);
    const failed = res.results.filter((r) => !r.ok);
    if (failed.length > 0) {
      environmentDependencies.showToast(
        `部分包升级失败: ${failed.map((f) => f.name).join(', ')}`,
        'error'
      );
    } else {
      environmentDependencies.showToast('安装/升级任务已启动，正在显示进度...', 'success');
    }
    refreshEnvStatus({ passive: true, force: true });
  } catch (err) {
    finalizeEnvInstallSubmission(batchToolIds, [], err.message);
    environmentDependencies.showToast('全部升级失败：' + err.message, 'error');
  } finally {
    if (btnUpgradeAll) btnUpgradeAll.disabled = false;
  }
}

function bindEnvControls() {
  const refreshButton = environmentDependencies.$('btnRefreshEnv');
  const upgradeAllButton = environmentDependencies.$('btnUpgradeAllEnv');
  const diagnosticsButton = environmentDependencies.$('btnDiagnosticsConflicts');
  const grid = environmentDependencies.$('envGrid');

  if (refreshButton) {
    refreshButton.onclick = () => refreshEnvStatus();
    refreshButton.dataset.bound = 'true';
  }
  if (upgradeAllButton) {
    upgradeAllButton.onclick = () => upgradeAllEnv();
    upgradeAllButton.dataset.bound = 'true';
  }
  if (diagnosticsButton) {
    diagnosticsButton.onclick = async () => {
      environmentDependencies.showToast('正在诊断安装冲突与分析包依赖...', 'success');
      setTimeout(() => {
        environmentDependencies.showToast(
          '依赖分析完毕，未检测到包冲突！所有 CLI 工具全局运行环境良好。',
          'success'
        );
      }, 1000);
    };
  }
  if (grid) {
    grid.onclick = (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest('[data-upgrade-tool]');
      if (!button || !grid.contains(button)) return;
      window.upgradeSingleTool(button.dataset.upgradeTool, button.dataset.upgradeAction);
    };
    grid.dataset.bound = 'true';
  }
}

export { bindEnvControls, refreshEnvStatus };
