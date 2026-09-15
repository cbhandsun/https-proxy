const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseBoundedInteger, readLastLinesOfJsonl } = require('./management-utils');

const MAX_RATE_LIMIT_COUNT = 1000000000;
const MAX_RESET_SECONDS = 365 * 24 * 60 * 60;
const MAX_WINDOW_MINUTES = 365 * 24 * 60;

function formatResetDisplayFromEpochMs(resetMs, nowMs = Date.now()) {
  const value = Number(resetMs);
  if (!Number.isFinite(value) || value <= 0) return '';
  const reset = new Date(value);
  const now = new Date(nowMs);
  const sameDay =
    reset.getFullYear() === now.getFullYear() &&
    reset.getMonth() === now.getMonth() &&
    reset.getDate() === now.getDate();
  if (sameDay) {
    return `${String(reset.getHours()).padStart(2, '0')}:${String(reset.getMinutes()).padStart(2, '0')}`;
  }
  return `${reset.getMonth() + 1}月${reset.getDate()}日`;
}

function formatResetInFromEpochSeconds(epochSeconds, nowMs = Date.now()) {
  const resetMs = Number(epochSeconds) * 1000;
  if (!Number.isFinite(resetMs) || resetMs <= 0) return '';
  const resetSec = Math.max(0, Math.round((resetMs - nowMs) / 1000));
  if (resetSec < 3600) return Math.ceil(resetSec / 60) + 'm';
  if (resetSec < 86400) {
    const h = Math.floor(resetSec / 3600);
    const m = Math.ceil((resetSec % 3600) / 60);
    return `${h}h${m}m`;
  }
  const d = Math.floor(resetSec / 86400);
  const h = Math.ceil((resetSec % 86400) / 3600);
  return `${d}d${h}h`;
}

function formatWindowMinutes(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 10080 && value % 10080 === 0) return Math.round(value / 10080) + '周';
  if (value >= 1440) return Math.round(value / 1440) + '天';
  return Math.round(value / 60) + '小时';
}

function formatRateLimits(data, nowMs = Date.now()) {
  if (!data || !Array.isArray(data.rate_limits)) {
    return [];
  }
  return data.rate_limits.map((limit) => {
    const max = parseBoundedInteger(limit.max_requests, 0, 0, MAX_RATE_LIMIT_COUNT);
    const remaining = Math.min(
      parseBoundedInteger(limit.remaining, 0, 0, MAX_RATE_LIMIT_COUNT),
      max || MAX_RATE_LIMIT_COUNT
    );
    const used = Math.max(0, max - remaining);
    const usedPercent = max > 0 ? Math.round((used / max) * 100) : 0;
    const remainingPercent =
      max > 0 ? Math.max(0, Math.min(100, Math.round((remaining / max) * 100))) : 0;

    const windowSec = parseBoundedInteger(limit.window_size_seconds, 0, 0, MAX_RESET_SECONDS);
    let windowStr;
    if (windowSec >= 604800 && windowSec % 604800 === 0) {
      windowStr = Math.round(windowSec / 604800) + '周';
    } else if (windowSec >= 86400) {
      windowStr = Math.round(windowSec / 86400) + '天';
    } else {
      windowStr = Math.round(windowSec / 3600) + '小时';
    }

    const resetSec = parseBoundedInteger(limit.reset_in_seconds, 0, 0, MAX_RESET_SECONDS);
    let resetStr;
    if (resetSec < 3600) {
      resetStr = Math.round(resetSec / 60) + 'm';
    } else if (resetSec < 86400) {
      const h = Math.floor(resetSec / 3600);
      const m = Math.round((resetSec % 3600) / 60);
      resetStr = `${h}h${m}m`;
    } else {
      const d = Math.floor(resetSec / 86400);
      const h = Math.round((resetSec % 86400) / 3600);
      resetStr = `${d}d${h}h`;
    }

    return {
      window: windowStr,
      percent: remainingPercent,
      remainingPercent,
      usedPercent,
      resetIn: resetStr,
      resetDisplay: formatResetDisplayFromEpochMs(nowMs + resetSec * 1000, nowMs),
    };
  });
}

function formatCodexLocalRateLimits(rateLimits, nowMs = Date.now()) {
  if (!rateLimits || typeof rateLimits !== 'object') return [];
  return ['primary', 'secondary']
    .map((key) => {
      const limit = rateLimits[key];
      if (!limit || typeof limit !== 'object') return null;
      const usedPercent = parseBoundedInteger(limit.used_percent, 0, 0, 100);
      const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent));
      const windowMinutes = parseBoundedInteger(limit.window_minutes, 0, 0, MAX_WINDOW_MINUTES);
      const resetsAt = parseBoundedInteger(limit.resets_at, 0, 0, Number.MAX_SAFE_INTEGER);
      return {
        window: formatWindowMinutes(windowMinutes),
        percent: remainingPercent,
        remainingPercent,
        usedPercent,
        resetIn: formatResetInFromEpochSeconds(resetsAt, nowMs),
        resetDisplay: formatResetDisplayFromEpochMs(resetsAt * 1000, nowMs),
        resetAt: resetsAt || null,
        limitId: rateLimits.limit_id || 'codex',
        planType: rateLimits.plan_type || '',
      };
    })
    .filter((item) => item && item.window);
}

function formatUpstreamCooldowns(cooldowns, nowMs = Date.now()) {
  if (!Array.isArray(cooldowns)) return [];
  return cooldowns
    .map((cooldown) => {
      if (!cooldown || typeof cooldown !== 'object') return null;
      const retryAfterSeconds = parseBoundedInteger(
        cooldown.retryAfterSeconds,
        0,
        0,
        MAX_RESET_SECONDS
      );
      const resetAt =
        parseBoundedInteger(cooldown.resetAt, 0, 0, Number.MAX_SAFE_INTEGER) ||
        Math.ceil((nowMs + retryAfterSeconds * 1000) / 1000);
      const profileId =
        typeof cooldown.profileId === 'string' ? cooldown.profileId.trim().slice(0, 200) : '';
      const targetModel =
        typeof cooldown.targetModel === 'string' ? cooldown.targetModel.trim().slice(0, 200) : '';
      if (!retryAfterSeconds || !profileId || !targetModel) return null;
      return {
        profileId,
        targetModel,
        model: targetModel,
        retryAfterSeconds,
        resetAt,
        resetIn: formatResetInFromEpochSeconds(resetAt, nowMs),
        resetDisplay: formatResetDisplayFromEpochMs(resetAt * 1000, nowMs),
        source:
          typeof cooldown.source === 'string' && cooldown.source.trim()
            ? cooldown.source.trim().slice(0, 100)
            : 'local_cooldown',
      };
    })
    .filter(Boolean)
    .slice(0, 100);
}

function listRecentCodexSessionFiles(maxFiles = 30) {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = fs.statSync(fullPath);
          files.push({ path: fullPath, mtimeMs: stat.mtimeMs });
        } catch (err) {}
      }
    }
  }
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles)
    .map((item) => item.path);
}

function listCodexSessionFilesForThread(threadId, maxFiles = 10) {
  const id = String(threadId || '').trim();
  if (!id) return [];
  return listRecentCodexSessionFiles(200)
    .filter((filePath) => path.basename(filePath).includes(id))
    .slice(0, maxFiles);
}

function prioritizeCodexSessionFiles(files, threadId) {
  const id = String(threadId || '').trim();
  const seen = new Set();
  const unique = (files || []).filter((filePath) => {
    if (!filePath || seen.has(filePath)) return false;
    seen.add(filePath);
    return true;
  });
  if (!id) return unique;
  return unique.slice().sort((a, b) => {
    const aMatch = path.basename(a).includes(id) ? 1 : 0;
    const bMatch = path.basename(b).includes(id) ? 1 : 0;
    return bMatch - aMatch;
  });
}

function readLatestCodexLocalRateLimits() {
  const preferredThreadId =
    process.env.CODEX_THREAD_ID ||
    process.env.CODEX_SESSION_ID ||
    process.env.CODEX_CONVERSATION_ID ||
    '';
  const preferredFiles = listCodexSessionFilesForThread(preferredThreadId);
  const files = prioritizeCodexSessionFiles(
    preferredFiles.concat(listRecentCodexSessionFiles()),
    preferredThreadId
  );

  for (const filePath of files) {
    const events = readLastLinesOfJsonl(filePath, 600, 1024 * 1024);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const payload = events[i] && events[i].payload;
      const rateLimits = payload && payload.rate_limits;
      const formatted = formatCodexLocalRateLimits(rateLimits);
      if (formatted.length) {
        return {
          ok: true,
          limits: formatted,
          source: 'codex-local-session',
          threadId: preferredFiles.includes(filePath) ? preferredThreadId : undefined,
          planType: rateLimits.plan_type || '',
          limitId: rateLimits.limit_id || 'codex',
        };
      }
    }
  }
  return { ok: false, limits: [], error: '未找到 Codex 本地会话限额数据。' };
}

module.exports = {
  formatRateLimits,
  formatResetInFromEpochSeconds,
  formatResetDisplayFromEpochMs,
  formatWindowMinutes,
  formatCodexLocalRateLimits,
  formatUpstreamCooldowns,
  listRecentCodexSessionFiles,
  listCodexSessionFilesForThread,
  prioritizeCodexSessionFiles,
  readLatestCodexLocalRateLimits,
};
