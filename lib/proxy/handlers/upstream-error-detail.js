/**
 * 上游错误正文的审计字段。
 *
 * 之前 `responses_to_gemini_error` 只记状态码和类型，无法判断上游到底返回了什么，
 * 每次调查都要靠时间点猜。这里统一解析出 message/status/code/描述性字段，并对
 * 正文做有界截断，避免日志被大响应体或密钥撑爆。
 */
'use strict';

const { sanitizeLogText } = require('../logger');

const DEFAULT_MAX_ERROR_BODY_CHARS = 2000;

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function boundedErrorBody(body, maxChars = DEFAULT_MAX_ERROR_BODY_CHARS) {
  const limit =
    Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
      ? Math.trunc(Number(maxChars))
      : DEFAULT_MAX_ERROR_BODY_CHARS;
  const text = sanitizeLogText(typeof body === 'string' ? body : '');
  if (!text) return { text: '', truncated: false, originalLength: 0 };
  const originalLength = text.length;
  if (originalLength <= limit) return { text, truncated: false, originalLength };
  return { text: text.slice(0, limit) + '...[truncated]', truncated: true, originalLength };
}

function upstreamErrorDetail(body, options = {}) {
  const bounded = boundedErrorBody(body, options.maxChars);
  const detail = {
    upstreamErrorBody: bounded.text,
    upstreamErrorBodyTruncated: bounded.truncated,
    upstreamErrorBodyLength: bounded.originalLength,
  };
  if (!bounded.text) return detail;

  let parsed = null;
  try {
    parsed = JSON.parse(bounded.text);
  } catch (err) {}
  const error = parsed && typeof parsed === 'object' ? parsed.error || parsed : null;
  if (!error || typeof error !== 'object') return detail;

  const message = firstString(error.message, error.error, error.detail, error.details);
  if (message) detail.upstreamErrorMessage = message;
  const status = firstString(error.status, error.state);
  if (status) detail.upstreamErrorStatus = status;
  const code = firstString(error.code, error.type, error.reason);
  if (code) detail.upstreamErrorCode = code;
  return detail;
}

module.exports = {
  DEFAULT_MAX_ERROR_BODY_CHARS,
  boundedErrorBody,
  upstreamErrorDetail,
};
