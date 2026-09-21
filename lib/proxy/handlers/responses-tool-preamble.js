/**
 * Responses 工具前置语判定：决定是否在 Gemini 工具调用前注入一句人类可读的前置语，
 * 以及根据输入内容选择中文或英文文案。纯函数，便于独立测试。
 */
'use strict';

const RESPONSES_PREAMBLE_SCAN_CHAR_BUDGET = 20000;

function inputContainsCjk(value, budget = { remaining: RESPONSES_PREAMBLE_SCAN_CHAR_BUDGET }) {
  if (!budget || budget.remaining <= 0) return false;
  if (typeof value === 'string') {
    const text = value.slice(0, budget.remaining);
    budget.remaining -= text.length;
    return /[\u3400-\u9fff]/.test(text);
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      if (inputContainsCjk(value[index], budget)) return true;
      if (budget.remaining <= 0) return false;
    }
    return false;
  }
  if (!value || typeof value !== 'object') return false;
  const priorityKeys = ['text', 'input', 'content', 'output', 'message', 'messages'];
  const seen = new Set();
  for (const key of priorityKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    seen.add(key);
    if (inputContainsCjk(value[key], budget)) return true;
    if (budget.remaining <= 0) return false;
  }
  for (const key of Object.keys(value)) {
    if (seen.has(key)) continue;
    if (inputContainsCjk(value[key], budget)) return true;
    if (budget.remaining <= 0) return false;
  }
  return false;
}

function responsesToolPreambleText(parsed) {
  return inputContainsCjk(parsed && parsed.input) ? '我先看一下。' : "I'll take a look.";
}

function responsesInputNeedsToolPreamble(input) {
  if (typeof input === 'string') return input.trim().length > 0;
  if (Array.isArray(input)) {
    for (let index = input.length - 1; index >= 0; index -= 1) {
      const item = input[index];
      if (!item || typeof item !== 'object') continue;
      const type = typeof item.type === 'string' ? item.type : '';
      if (
        type === 'function_call_output' ||
        type === 'custom_tool_call_output' ||
        type === 'tool_result'
      ) {
        return false;
      }
      if (type === 'message' || type === 'input_text' || item.role === 'user') return true;
      if (item.role === 'tool' || item.role === 'function') return false;
    }
    return false;
  }
  if (!input || typeof input !== 'object') return false;
  return input.role === 'user' || input.type === 'message' || input.type === 'input_text';
}

module.exports = {
  RESPONSES_PREAMBLE_SCAN_CHAR_BUDGET,
  inputContainsCjk,
  responsesInputNeedsToolPreamble,
  responsesToolPreambleText,
};
