'use strict';

/**
 * OpenAI Chat -> Responses request conversion.
 *
 * Extracted from protocol-openai.js so this pure request-shaping logic can be
 * reviewed and tested on its own. It touches no stream state and no I/O: it
 * only reshapes a chat-completions request body into a Responses request.
 */

function inferToolNameFromArguments(input) {
  if (!input || typeof input !== 'object') return '';
  if (input.subagent_type || (input.prompt && input.description && input.model)) return 'Agent';
  if (input.command) return 'Bash';
  if (input.file_path) return 'Read';
  if (
    input.pattern &&
    (input.glob || input.output_mode || input.head_limit != null || input.context != null)
  )
    return 'Grep';
  if (input.pattern && input.path) return 'Glob';
  if (input.subject && input.description && input.activeForm) return 'TaskCreate';
  return '';
}

function normalizeServiceTier(value) {
  if (typeof value !== 'string') return null;
  const tier = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(tier)) return null;
  return tier;
}

function createResponsesRequestConverter({ fallbackId, chatToolContentToResponsesOutput }) {
  function responsesFunctionCallItemId(sourceId, seed) {
    if (typeof sourceId === 'string' && sourceId.indexOf('fc_') === 0) return sourceId;
    return fallbackId('fc', { source_id: sourceId || null, seed });
  }

  function responsesFunctionCallCallId(sourceId, seed) {
    if (typeof sourceId === 'string' && sourceId) return sourceId;
    return fallbackId('call', seed);
  }

  function openAIChatToResponsesRequest(body) {
    // The request body is client-supplied; a non-object used to reach
    // `body.model` and throw a TypeError out of the conversion layer.
    const source = body && typeof body === 'object' ? body : {};
    const result = {
      model: source.model,
      store: false,
    };

    const systemMessages = [];
    const otherMessages = [];

    for (const msg of Array.isArray(source.messages) ? source.messages : []) {
      if (!msg) continue;
      if (msg.role === 'system' || msg.role === 'developer') {
        systemMessages.push(msg.content);
      } else {
        otherMessages.push(msg);
      }
    }

    if (systemMessages.length > 0) {
      result.instructions = systemMessages
        .map((c) => {
          if (typeof c === 'string') return c;
          if (Array.isArray(c)) {
            return c.map((part) => (part && part.text) || '').join('');
          }
          return String(c || '');
        })
        .join('\n');
    } else {
      result.instructions = 'You are a helpful assistant.';
    }

    const input = [];
    for (const msg of otherMessages) {
      if (msg.role === 'tool') {
        const item = {
          type: 'function_call_output',
          call_id: msg.tool_call_id || fallbackId('call', msg),
          output: chatToolContentToResponsesOutput(msg.content),
        };
        if (msg.is_error === true || msg.status === 'error') {
          item.status = 'error';
        }
        input.push(item);
        continue;
      }

      const role = msg.role === 'assistant' ? 'assistant' : 'user';

      const contentParts = [];
      if (typeof msg.content === 'string' && msg.content.trim()) {
        contentParts.push({
          type: role === 'user' ? 'input_text' : 'output_text',
          text: msg.content,
        });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part) continue;
          if (typeof part === 'string' && part.trim()) {
            contentParts.push({
              type: role === 'user' ? 'input_text' : 'output_text',
              text: part,
            });
          } else if (part.type === 'text' && part.text) {
            contentParts.push({
              type: role === 'user' ? 'input_text' : 'output_text',
              text: part.text,
            });
          } else if (part.type === 'image_url') {
            const url =
              typeof part.image_url === 'string'
                ? part.image_url
                : part.image_url && part.image_url.url;
            if (url) {
              contentParts.push({
                type: 'input_image',
                image_url: url,
              });
            }
          }
        }
      }

      if (contentParts.length > 0 || !Array.isArray(msg.tool_calls)) {
        input.push({
          type: 'message',
          role: role,
          content: contentParts,
        });
      }

      if (role === 'assistant' && Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          if (!call) continue;
          const fn = call.function || {};
          const args = fn.arguments || '{}';
          let parsedArgs = {};
          if (typeof args === 'string' && args.trim()) {
            try {
              parsedArgs = JSON.parse(args);
            } catch (err) {}
          } else if (args && typeof args === 'object') {
            parsedArgs = args;
          }
          const name = fn.name || call.name || inferToolNameFromArguments(parsedArgs);
          if (!name) continue;
          const seed = { name, arguments: args };
          input.push({
            type: 'function_call',
            id: responsesFunctionCallItemId(call.id, seed),
            call_id: responsesFunctionCallCallId(call.id, seed),
            name,
            arguments: typeof args === 'string' ? args : JSON.stringify(args),
          });
        }
      }
    }

    result.input = input;

    result.stream = true;

    // 剥离官方 Codex Pro / Responses 接口不支持的微调参数，防止上游返回 400 错误
    // 官方 Responses 端点 (chatgpt.com/backend-api/codex/responses) 只接收模型、输入、指令、tools、tool_choice、reasoning
    // 不支持 max_output_tokens, temperature, top_p, response_format 等
    if (source.reasoning_effort != null) {
      result.reasoning = { effort: source.reasoning_effort };
    }
    const serviceTier = normalizeServiceTier(source.service_tier);
    if (serviceTier) {
      result.service_tier = serviceTier;
    }

    if (Array.isArray(source.tools)) {
      result.tools = source.tools
        .filter((t) => t && t.type === 'function' && t.function)
        .map((t) => {
          const fn = t.function;
          return {
            type: 'function',
            name: fn.name,
            description: fn.description || '',
            parameters: fn.parameters || { type: 'object', properties: {} },
            strict: fn.strict,
          };
        });
    }

    if (source.tool_choice != null) {
      if (typeof source.tool_choice === 'string') {
        result.tool_choice = source.tool_choice;
      } else if (source.tool_choice.type === 'function' && source.tool_choice.function) {
        result.tool_choice = {
          type: 'function',
          name: source.tool_choice.function.name,
        };
      }
    }

    return result;
  }

  return { openAIChatToResponsesRequest, responsesFunctionCallItemId, responsesFunctionCallCallId };
}

module.exports = {
  createResponsesRequestConverter,
  inferToolNameFromArguments,
  normalizeServiceTier,
};
