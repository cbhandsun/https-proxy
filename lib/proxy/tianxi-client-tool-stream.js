'use strict';
const { randomUUID } = require('node:crypto');
const { writeResponsesSseEvent, writeTianxiResultCall } = require('./tianxi-responses');

// This stream contains factual lifecycle notices, not manufactured reasoning.
function createTianxiClientToolStream(clientRes, model) {
  const id = 'resp_' + randomUUID().replace(/-/g, '');
  const created_at = Math.floor(Date.now() / 1000);
  const output = [];
  const seen = new Set();
  const write = (type, value) => writeResponsesSseEvent(clientRes, type, { type, ...value });
  const base = {
    id,
    object: 'response',
    created_at,
    model,
    output: [],
    output_text: '',
    error: null,
    incomplete_details: null,
    usage: null,
  };
  for (const type of ['response.created', 'response.in_progress'])
    write(type, { response: { ...base, status: 'in_progress' } });
  function message(text, phase) {
    const index = output.length;
    const item = {
      id: 'msg_' + id + '_' + index,
      type: 'message',
      role: 'assistant',
      phase,
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
    };
    const meta = { response_id: id, item_id: item.id, output_index: index, content_index: 0 };
    write('response.output_item.added', {
      response_id: id,
      output_index: index,
      item: { ...item, status: 'in_progress', content: [] },
    });
    write('response.content_part.added', { ...meta, part: { ...item.content[0], text: '' } });
    write('response.output_text.delta', { ...meta, delta: text, logprobs: [] });
    write('response.output_text.done', { ...meta, text, logprobs: [] });
    write('response.content_part.done', { ...meta, part: item.content[0] });
    write('response.output_item.done', { response_id: id, output_index: index, item });
    output.push(item);
  }
  return {
    notice(code) {
      if (code && typeof code === 'object') {
        let progress;
        try {
          progress = Object.getOwnPropertyDescriptor(code, 'progress')?.value;
        } catch {
          return;
        }
        if (
          typeof progress !== 'string' ||
          !progress.trim() ||
          progress.length > 320 ||
          [...progress].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
          ) ||
          seen.has(progress) ||
          clientRes.destroyed ||
          clientRes.writableEnded
        )
          return;
        seen.add(progress);
        message(progress, 'commentary');
        return;
      }
      const texts = {
        started: '天禧任务已开始，正在等待模型返回操作。',
        resumed: '工具结果已回传，天禧正在继续处理。',
        running: '天禧已返回运行状态，正在处理任务。',
        waiting: '仍在等待天禧返回有效进展，尚未收到后续结果。',
      };
      if (
        typeof code !== 'string' ||
        !Object.hasOwn(texts, code) ||
        seen.has(code) ||
        clientRes.destroyed ||
        clientRes.writableEnded
      )
        return;
      seen.add(code);
      message(texts[code], 'commentary');
    },
    finish(value) {
      for (const item of value.output || []) {
        if (item.type === 'custom_tool_call') {
          writeTianxiResultCall(clientRes, { id, outputIndex: output.length }, item);
          output.push(item);
        } else if (item.type === 'message' && item.phase !== 'commentary') {
          for (const part of item.content || [])
            if (part.type === 'output_text') message(part.text, 'final_answer');
        }
      }
      const response = { ...value, id, created_at, output };
      write('response.' + response.status, { response });
      clientRes.end('data: [DONE]\n\n');
      return response;
    },
  };
}
module.exports = { createTianxiClientToolStream };
