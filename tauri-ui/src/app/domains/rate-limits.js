import { bindDomainDependencies } from '../runtime/dependencies.js';

const RATE_LIMIT_REFRESH_DELAY_MS = 2500;
const RATE_LIMIT_CLOCK_INTERVAL_MS = 15000;
const MAX_RATE_LIMIT_ROWS = 100;

const rateLimitsData = Object.create(null);
const deferredRateLimitTimers = new Map();
let rateLimitDependencies;
let limitsTimeDisplayTimer = null;
let lastRenderedLimitsProfileId = '';
let lastRenderedLimitsSignature = '';
let lastRenderedLimitsTimeText = '';

export function configureRateLimits(runtime) {
  rateLimitDependencies = bindDomainDependencies('rate-limits', runtime, [
    '$',
    'selectedId',
    'showToast',
  ]);
}

function dependencies() {
  if (!rateLimitDependencies) {
    throw new Error('rate-limits domain is not configured');
  }
  return rateLimitDependencies;
}

function errorMessage(error, fallback = '获取失败') {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, 1000);
  if (typeof error === 'string' && error.trim()) return error.trim().slice(0, 1000);
  return fallback;
}

function normalizeLimit(limit) {
  if (!limit || typeof limit !== 'object' || Array.isArray(limit)) return null;
  const percent = Number(limit.percent);
  const remainingPercent = Number(limit.remainingPercent);
  return {
    model: typeof limit.model === 'string' ? limit.model.slice(0, 200) : '',
    window: typeof limit.window === 'string' ? limit.window.slice(0, 200) : '',
    percent: Number.isFinite(percent) ? percent : 0,
    remainingPercent: Number.isFinite(remainingPercent) ? remainingPercent : undefined,
    resetDisplay: typeof limit.resetDisplay === 'string' ? limit.resetDisplay.slice(0, 200) : '',
    resetIn: typeof limit.resetIn === 'string' ? limit.resetIn.slice(0, 200) : '',
  };
}

export function parseRateLimitsResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: '服务返回了无效响应' };
  }
  if (value.ok !== true) {
    return { ok: false, error: errorMessage(value.error) };
  }
  return {
    ok: true,
    limits: (Array.isArray(value.limits) ? value.limits : [])
      .slice(0, MAX_RATE_LIMIT_ROWS)
      .map(normalizeLimit)
      .filter(Boolean),
  };
}

function getRelativeTime(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  if (diff < 60000) return '刚刚';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

function createLimitsTextElement(text, options = {}) {
  const item = document.createElement('span');
  item.textContent = text;
  if (options.color) item.style.color = options.color;
  item.style.opacity = options.opacity || '';
  item.style.fontSize = options.fontSize || '11px';
  return item;
}

function createLimitsSpinnerElement() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('animate-spin');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '3');
  svg.style.animation = 'spin 1s linear infinite';

  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', '23 4 23 10 17 10');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10');
  svg.append(polyline, path);
  return svg;
}

function limitsSignature(profileId) {
  const data = rateLimitsData[profileId];
  return JSON.stringify({
    profileId,
    loading: Boolean(data && data.loading),
    error: data && data.error ? String(data.error) : '',
    limits: data && Array.isArray(data.limits) ? data.limits : [],
  });
}

function createLimitsElement(profileId) {
  const data = rateLimitsData[profileId];
  if (!data) {
    return createLimitsTextElement('未同步凭证与限额', { opacity: '0.6' });
  }
  if (data.loading) {
    const loading = createLimitsTextElement('', { opacity: '0.8' });
    loading.style.display = 'inline-flex';
    loading.style.alignItems = 'center';
    loading.style.gap = '4px';
    loading.append(createLimitsSpinnerElement(), document.createTextNode('正在同步凭证与限额...'));
    return loading;
  }
  if (data.error) {
    return createLimitsTextElement(data.error, { color: '#ef4444' });
  }
  if (!data.limits || data.limits.length === 0) {
    return createLimitsTextElement('无限制数据', { opacity: '0.6' });
  }

  const fragment = document.createDocumentFragment();
  data.limits.forEach((limit, index) => {
    const value = Number.isFinite(limit.remainingPercent) ? limit.remainingPercent : limit.percent;
    const isRemaining = Number.isFinite(limit.remainingPercent);
    let color = '#10b981';
    if ((isRemaining && value <= 20) || (!isRemaining && value >= 80)) color = '#ef4444';
    else if ((isRemaining && value <= 50) || (!isRemaining && value >= 50)) color = '#f59e0b';

    const item = document.createElement('span');
    item.style.background = 'rgba(255, 255, 255, 0.03)';
    item.style.padding = '2px 6px';
    item.style.borderRadius = '4px';
    item.style.border = '1px solid var(--border)';
    item.style.display = 'inline-flex';
    item.style.alignItems = 'center';
    item.style.gap = '4px';
    item.appendChild(document.createTextNode(`${limit.model || limit.window}: `));

    const valueElement = document.createElement('strong');
    valueElement.style.color = color;
    valueElement.style.fontWeight = '700';
    valueElement.textContent = `${value}%`;
    item.appendChild(valueElement);

    const resetValue = limit.resetDisplay || limit.resetIn;
    if (resetValue) {
      item.appendChild(document.createTextNode(' '));
      const reset = document.createElement('span');
      reset.style.opacity = '0.6';
      reset.style.fontSize = '10px';
      reset.textContent = `🕒 ${resetValue}`;
      item.appendChild(reset);
    }
    if (index > 0) fragment.appendChild(document.createTextNode(' '));
    fragment.appendChild(item);
  });
  return fragment;
}

export function renderDashboardLimits(profileId) {
  const { $ } = dependencies();
  const container = $('rate-limits-container');
  const timeDisplay = $('rate-limits-time-display');
  if (!container) return;

  const signature = limitsSignature(profileId);
  if (profileId !== lastRenderedLimitsProfileId || signature !== lastRenderedLimitsSignature) {
    container.replaceChildren(createLimitsElement(profileId));
    lastRenderedLimitsProfileId = profileId;
    lastRenderedLimitsSignature = signature;
  }

  const data = rateLimitsData[profileId];
  if (timeDisplay) {
    const nextText =
      data && !data.loading ? `🕒 ${getRelativeTime(data.refreshedAt)}` : '🕒 未同步';
    if (nextText !== lastRenderedLimitsTimeText) {
      timeDisplay.textContent = nextText;
      lastRenderedLimitsTimeText = nextText;
    }
  }
}

async function requestRateLimits(profileId) {
  try {
    const result = parseRateLimitsResponse(await window.proxyManager.getRateLimits(profileId));
    rateLimitsData[profileId] = result.ok
      ? { limits: result.limits, refreshedAt: Date.now() }
      : { error: result.error, refreshedAt: Date.now() };
    return result;
  } catch (error) {
    const result = { ok: false, error: errorMessage(error) };
    rateLimitsData[profileId] = { error: result.error, refreshedAt: Date.now() };
    return result;
  }
}

export async function refreshRateLimits(profileId) {
  if (!profileId) return;
  const { selectedId } = dependencies();
  rateLimitsData[profileId] = { loading: true, refreshedAt: Date.now() };
  if (profileId === selectedId) renderDashboardLimits(profileId);
  await requestRateLimits(profileId);
  if (profileId === dependencies().selectedId) renderDashboardLimits(profileId);
}

export function scheduleRateLimitsRefresh(profileId) {
  if (!profileId || rateLimitsData[profileId] || deferredRateLimitTimers.has(profileId)) return;
  const timer = setTimeout(() => {
    deferredRateLimitTimers.delete(profileId);
    if (!rateLimitsData[profileId]) void refreshRateLimits(profileId);
  }, RATE_LIMIT_REFRESH_DELAY_MS);
  deferredRateLimitTimers.set(profileId, timer);
}

function updateLimitsTimeDisplay() {
  const { $, selectedId } = dependencies();
  const dashboard = $('limitsDashboard');
  if (dashboard && dashboard.style.display === 'none') return;
  const data = selectedId && rateLimitsData[selectedId];
  const timeDisplay = $('rate-limits-time-display');
  if (!timeDisplay || !data || data.loading) return;
  const nextText = `🕒 ${getRelativeTime(data.refreshedAt)}`;
  if (nextText !== lastRenderedLimitsTimeText) {
    timeDisplay.textContent = nextText;
    lastRenderedLimitsTimeText = nextText;
  }
}

export function startRateLimitsTimeDisplay() {
  if (!limitsTimeDisplayTimer) {
    limitsTimeDisplayTimer = setInterval(updateLimitsTimeDisplay, RATE_LIMIT_CLOCK_INTERVAL_MS);
  }
}

export async function refreshRateLimitsFromUI() {
  const { $, selectedId, showToast } = dependencies();
  if (!selectedId) return;
  const profileId = selectedId;
  const button = $('refresh-limits-action');
  const icon = button && button.querySelector('svg');
  if (button) button.disabled = true;
  if (icon) icon.style.animation = 'spin 1s linear infinite';

  rateLimitsData[profileId] = { loading: true, refreshedAt: Date.now() };
  renderDashboardLimits(profileId);
  const result = await requestRateLimits(profileId);
  if (result.ok) {
    showToast('官方凭证与使用限额同步成功', 'success');
  } else {
    showToast(`同步限额失败：${result.error}`, 'error');
  }

  if (button) button.disabled = false;
  if (icon) icon.style.animation = 'none';
  renderDashboardLimits(profileId);
}
