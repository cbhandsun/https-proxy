/**
 * Trae OpenAI Bridge Extension - 原始事件脱敏
 *
 * 拆分自 extension.js (536 行),把 raw stream event 中的敏感字段
 * (authorization / bearer / token / api[_-]?key / secret / password /
 * credential / refresh 等) 替换为 [redacted],把超长文本截断到 500
 * 字符 + 保留 chars 计数,避免把整段 prompt/answer 推到调试通道。
 *
 * 纯函数,不依赖 vscode,可独立单测。
 */

const SENSITIVE_RAW_KEY_PATTERN = /authorization|bearer|token|api[_-]?key|secret|password|credential|access[_-]?key|refresh|session[_-]?key|(?:^|[_-])(ak|sk)(?:$|[_-])/i;
const TEXT_RAW_KEY_PATTERN = /reasoning|thought|prompt|content|text|markdown|delta|answer|reply/i;
const SAFE_RAW_TEXT_KEYS = new Set([
  'event',
  'type',
  'status',
  'phase',
  'code',
  'id',
  'session_id',
  'sessionid',
  'message_id',
  'messageid',
  'agent_message_id',
  'agentmessageid',
  'tool_call_id',
  'toolcallid',
  'plan_item_id',
  'planitemid',
  'tool_name',
  'toolname',
  'model_name',
  'modelname',
  'config_name',
  'configname'
]);

function normalizeRawKey(key) {
  return String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function sanitizeRawValue(value, key, depth = 0) {
  if (value == null) return value;
  const keyText = String(key || '');
  const normalizedKey = normalizeRawKey(keyText);

  if (SENSITIVE_RAW_KEY_PATTERN.test(keyText)) return '[redacted]';
  if (typeof value === 'string') {
    if (TEXT_RAW_KEY_PATTERN.test(keyText) && !SAFE_RAW_TEXT_KEYS.has(normalizedKey)) {
      return { redacted: true, chars: value.length };
    }
    return value.length > 500 ? `${value.slice(0, 500)}...[truncated ${value.length - 500} chars]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return String(value);
  if (depth >= 4) return '[max-depth]';
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item, index) => sanitizeRawValue(item, `${keyText}.${index}`, depth + 1));
    if (value.length > items.length) items.push(`[truncated ${value.length - items.length} items]`);
    return items;
  }

  const output = {};
  const entries = Object.entries(value).slice(0, 80);
  for (const [childKey, childValue] of entries) {
    output[childKey] = sanitizeRawValue(childValue, childKey, depth + 1);
  }
  const totalKeys = Object.keys(value).length;
  if (totalKeys > entries.length) output.__truncatedKeys = totalKeys - entries.length;
  return output;
}

function sanitizeRawStreamEvent(event) {
  const payload = event && typeof event === 'object' ? event : {};
  return {
    ts: typeof payload.ts === 'number' ? payload.ts : Date.now(),
    service: typeof payload.service === 'string' ? payload.service : undefined,
    method: typeof payload.method === 'string' ? payload.method : undefined,
    channelId: typeof payload.channelId === 'string' ? payload.channelId : undefined,
    sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
    agentMessageId: typeof payload.agentMessageId === 'string' ? payload.agentMessageId : undefined,
    event: typeof payload.event === 'string' ? payload.event : String(payload.event || ''),
    payload: sanitizeRawValue(payload.payload, 'payload')
  };
}

function makeRawEventKey(event) {
  if (!event || typeof event !== 'object') return JSON.stringify(event);
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  return [
    event.ts,
    event.service,
    event.method,
    event.channelId,
    event.sessionId,
    event.agentMessageId,
    event.event,
    payload.message_id,
    payload.id,
    payload.task_id,
    payload.tool_call_info && payload.tool_call_info.id
  ].filter(Boolean).join('|');
}

module.exports = {
  sanitizeRawValue,
  sanitizeRawStreamEvent,
  makeRawEventKey,
  SENSITIVE_RAW_KEY_PATTERN,
  TEXT_RAW_KEY_PATTERN,
  SAFE_RAW_TEXT_KEYS,
  normalizeRawKey,
};
