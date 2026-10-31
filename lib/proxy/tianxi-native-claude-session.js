'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { AbortController } = globalThis;
const { runTianxiSdkMcpExperiment } = require('./tianxi-sdk-mcp-runtime');
const { TIANXI_SDK_MODELS } = require('./tianxi-sdk-models');

const DEFAULT_MODEL = 'tianxi/qwen3.8-flash';
const MODELS = Object.freeze([
  DEFAULT_MODEL,
  ...TIANXI_SDK_MODELS.map((model) => model.alias).filter((alias) => alias !== DEFAULT_MODEL),
]);

function resolveSdkModelId(modelName) {
  const matched = TIANXI_SDK_MODELS.find(
    (m) => m.alias === modelName || m.modelId === modelName || m.name.toLowerCase() === String(modelName).toLowerCase()
  );
  return matched ? matched.modelId : 'qfmodel';
}

function convertClaudeToolsToMcp(tools) {
  if (!Array.isArray(tools) || !tools.length) return [];
  return tools
    .filter((t) => t && typeof t === 'object' && typeof t.name === 'string')
    .map((t) => ({
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      inputSchema:
        t.input_schema && typeof t.input_schema === 'object' && !Array.isArray(t.input_schema)
          ? t.input_schema
          : { type: 'object' },
    }));
}

function extractSystemPrompt(system) {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function extractToolResults(messages) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role !== 'user' || !Array.isArray(lastMsg.content)) return [];
  return lastMsg.content.filter((part) => part && part.type === 'tool_result');
}

function formatClaudeMessagesPrompt(messages) {
  if (!Array.isArray(messages)) return '';
  const lines = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;
    let textContent = '';
    const toolUses = [];
    const toolResults = [];

    if (typeof msg.content === 'string') {
      textContent = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          textContent += (textContent ? '\n' : '') + part.text;
        } else if (part.type === 'tool_use') {
          toolUses.push(part);
        } else if (part.type === 'tool_result') {
          toolResults.push(part);
        }
      }
    }

    if (role === 'user') {
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          const resText =
            typeof tr.content === 'string'
              ? tr.content
              : Array.isArray(tr.content)
                ? tr.content.map((c) => c?.text || JSON.stringify(c)).join('\n')
                : JSON.stringify(tr.content || '');
          lines.push(`[Tool Result for ${tr.tool_use_id}${tr.is_error ? ' (error)' : ''}]:\n${resText}`);
        }
      }
      if (textContent) {
        lines.push(`User: ${textContent}`);
      }
    } else if (role === 'assistant') {
      if (textContent) {
        lines.push(`Assistant: ${textContent}`);
      }
      for (const tu of toolUses) {
        lines.push(`[Assistant Tool Call ${tu.name} (${tu.id})]: ${JSON.stringify(tu.input || {})}`);
      }
    }
  }
  return lines.join('\n\n');
}

function writeClaudeMessageJsonResponse(res, step, model) {
  const messageId = 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24);
  const content = [];
  if (step.text) {
    content.push({ type: 'text', text: step.text });
  }
  if (step.toolCall) {
    content.push({
      type: 'tool_use',
      id: step.toolCall.id,
      name: step.toolCall.name,
      input: step.toolCall.input,
    });
  }

  const payload = {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: step.toolCall ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: step.inputTokens || 100,
      output_tokens: step.outputTokens || 50,
    },
  };

  const body = JSON.stringify(payload);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function writeClaudeMessageStream(res, step, model) {
  const messageId = 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'access-control-allow-origin': '*',
  });

  const emit = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  emit('message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: step.inputTokens || 100, output_tokens: 0 },
    },
  });

  let blockIndex = 0;
  if (step.text) {
    emit('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    });
    emit('content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'text_delta', text: step.text },
    });
    emit('content_block_stop', {
      type: 'content_block_stop',
      index: blockIndex++,
    });
  }

  if (step.toolCall) {
    emit('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'tool_use',
        id: step.toolCall.id,
        name: step.toolCall.name,
        input: {},
      },
    });

    const json = JSON.stringify(step.toolCall.input || {});
    const chunkSize = 4096;
    for (let i = 0; i < json.length; i += chunkSize) {
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: json.slice(i, i + chunkSize),
        },
      });
    }

    emit('content_block_stop', {
      type: 'content_block_stop',
      index: blockIndex++,
    });

    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: step.outputTokens || 50 },
    });
  } else {
    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: step.outputTokens || 50 },
    });
  }

  emit('message_stop', { type: 'message_stop' });
  res.end();
}

function createTianxiNativeClaudeSessions({
  run = runTianxiSdkMcpExperiment,
  now = Date.now,
  maxSessions = 64,
  ttlMs = 300000,
} = {}) {
  const records = new Set();
  const toolCallMap = new Map();

  function sweep() {
    const cutoff = now() - ttlMs;
    for (const record of records) {
      if (record.touched < cutoff) {
        record.controller.abort();
        for (const id of record.callIds) toolCallMap.delete(id);
        records.delete(record);
      }
    }
  }

  async function handleClaudeRequest(body, owner, clientSignal) {
    sweep();
    const model = body.model || DEFAULT_MODEL;
    const modelId = resolveSdkModelId(model);
    const mcpTools = convertClaudeToolsToMcp(body.tools);
    const systemPrompt = extractSystemPrompt(body.system);
    const toolResults = extractToolResults(body.messages);

    // Check if this is continuation with tool_result
    if (toolResults.length > 0) {
      const primaryResult = toolResults[0];
      const record = toolCallMap.get(primaryResult.tool_use_id);
      if (record && !record.done && record.pendingResolve) {
        record.touched = now();
        const resText =
          typeof primaryResult.content === 'string'
            ? primaryResult.content
            : Array.isArray(primaryResult.content)
              ? primaryResult.content.map((c) => c?.text || JSON.stringify(c)).join('\n')
              : JSON.stringify(primaryResult.content || '');

        const resolveFn = record.pendingResolve;
        record.pendingResolve = null;
        resolveFn({
          content: [{ type: 'text', text: resText }],
          isError: Boolean(primaryResult.is_error),
        });

        const nextStep = await record.waitForNext();
        return nextStep;
      }
    }

    // New conversation turn
    const prompt = formatClaudeMessagesPrompt(body.messages);
    if (!prompt.trim()) {
      return { text: 'Hello! How can I help you today?' };
    }

    const controller = new AbortController();
    const abortOnClient = () => controller.abort();
    clientSignal?.addEventListener('abort', abortOnClient, { once: true });

    let pendingStep = null;
    let stepResolve = null;
    let stepPromise = new Promise((res) => {
      stepResolve = res;
    });

    const callIds = new Set();
    const record = {
      owner,
      model,
      controller,
      callIds,
      touched: now(),
      done: false,
      pendingResolve: null,
      waitForNext: () => {
        stepPromise = new Promise((res) => {
          stepResolve = res;
        });
        return stepPromise;
      },
    };

    records.add(record);

    run({
      modelId,
      prompt,
      systemPrompt,
      tools: mcpTools,
      timeoutMs: 300000,
      toolTimeoutMs: 600000,
      allowExtendedLimits: true,
      signal: controller.signal,
      onCall: async (name, args, context) => {
        const callId = 'toolu_' + randomUUID().replace(/-/g, '').slice(0, 24);
        callIds.add(callId);
        toolCallMap.set(callId, record);

        const step = {
          toolCall: {
            id: callId,
            name,
            input: args || {},
          },
        };

        const resultPromise = new Promise((resolve) => {
          record.pendingResolve = resolve;
        });

        stepResolve?.(step);
        return resultPromise;
      },
    })
      .then((result) => {
        record.done = true;
        const text = result?.finalText ?? result?.output ?? '';
        stepResolve?.({ text });
      })
      .catch((error) => {
        record.done = true;
        const msg = error?.message || 'Tianxi Claude session encountered an error.';
        stepResolve?.({ text: `[Error: ${msg}]` });
      })
      .finally(() => {
        clientSignal?.removeEventListener('abort', abortOnClient);
      });

    return await stepPromise;
  }

  return {
    handleClaudeRequest,
  };
}

module.exports = {
  createTianxiNativeClaudeSessions,
  writeClaudeMessageJsonResponse,
  writeClaudeMessageStream,
  convertClaudeToolsToMcp,
  extractSystemPrompt,
  formatClaudeMessagesPrompt,
  resolveSdkModelId,
};
