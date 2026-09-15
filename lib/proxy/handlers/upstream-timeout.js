/**
 * 上游超时解析。
 *
 * 之前主转发路径用 profile.timeoutMs（未配置时 120s），而转换路径硬编码 600s，
 * 同一份配置在不同入口得到不同行为。这里收敛成单一来源。
 */
'use strict';

const { parseBoundedInteger } = require('../management-utils');

const DEFAULT_UPSTREAM_TIMEOUT_MS = 120000;
const MIN_UPSTREAM_TIMEOUT_MS = 1000;
const MAX_UPSTREAM_TIMEOUT_MS = 1800000;

const bounded = (value, fallback) =>
  parseBoundedInteger(value, fallback, MIN_UPSTREAM_TIMEOUT_MS, MAX_UPSTREAM_TIMEOUT_MS);

/**
 * 优先级：profile.timeoutMs → PROXY_UPSTREAM_TIMEOUT_MS → 调用方默认值。
 * fallbackMs 保留各入口原有的默认时长（主转发 120s、转换路径 600s），使本次修复只
 * 改动"profile 配置被忽略"这一实际问题，而不顺手改变既有超时语义。
 */
function resolveUpstreamTimeout(profile, options = {}) {
  const { fallbackMs, env = process.env } = options;
  const fallback =
    Number.isFinite(Number(fallbackMs)) && Number(fallbackMs) > 0
      ? Number(fallbackMs)
      : DEFAULT_UPSTREAM_TIMEOUT_MS;
  if (profile && Number.isFinite(Number(profile.timeoutMs)) && Number(profile.timeoutMs) > 0) {
    return bounded(profile.timeoutMs, fallback);
  }
  return bounded(env && env.PROXY_UPSTREAM_TIMEOUT_MS, fallback);
}

module.exports = {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  MIN_UPSTREAM_TIMEOUT_MS,
  MAX_UPSTREAM_TIMEOUT_MS,
  resolveUpstreamTimeout,
};
