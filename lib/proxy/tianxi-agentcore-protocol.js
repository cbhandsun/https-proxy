'use strict';

const { randomUUID } = require('node:crypto');
const { parseTianxiBridgeFramesPayload } = require('./tianxi-responses');

const DEFAULT_TIANXI_AGENT_ID = 'writing_20251210105050d4fcd';
const DEFAULT_TIANXI_CHANNEL_NAME = 'aschannel';
const DEFAULT_TIANXI_QODER_MODEL = 'dfmodel';
const DEFAULT_TIANXI_WORKSPACE = 'C:\\Users\\juhon\\Tianxi';
const DEFAULT_TIANXI_CONFIG_PATH = 'C:\\ProgramData\\Lenovo\\AIAgent\\xlagent\\';
const DEFAULT_TIANXI_ALLOWED_TOOLS = Object.freeze([
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'AskUserQuestion',
  'Task',
  'Agent',
]);
const DEFAULT_TIANXI_DISALLOWED_TOOLS = Object.freeze(['ImageGen', 'ImageSearch', 'WebSearch']);
const MAX_PROMPT_CHARS = 128000;
const MAX_CONTEXT_CHARS = 32768;

function compactString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

function truncateText(value, maxChars) {
  const text = compactString(value);
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function contentPartText(part) {
  if (part == null) return '';
  if (typeof part === 'string') return part;
  if (typeof part !== 'object') return compactString(part);
  if (['input_text', 'output_text', 'text'].includes(part.type)) {
    return compactString(part.text || part.content || '');
  }
  if (part.type === 'function_call_output') return compactString(part.output || '');
  return '';
}

function messageText(message) {
  if (!message || typeof message !== 'object') return contentPartText(message);
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map(contentPartText).filter(Boolean).join('\n');
  }
  return contentPartText(message.content || message.text || message.output || '');
}

function extractTianxiPromptText(input) {
  if (typeof input === 'string') return truncateText(input, MAX_PROMPT_CHARS);
  if (!Array.isArray(input)) return truncateText(contentPartText(input), MAX_PROMPT_CHARS);
  const userMessages = input
    .filter((item) => item && typeof item === 'object' && item.role === 'user')
    .map(messageText)
    .filter(Boolean);
  const candidates =
    userMessages.length > 0 ? userMessages : input.map(messageText).filter(Boolean);
  return truncateText(candidates.join('\n'), MAX_PROMPT_CHARS);
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nativeGatewayChannel(tianxi, options) {
  return compactString(
    tianxi.gateway_channel || tianxi.gatewayChannel || options.gatewayChannel || 'agentCore'
  );
}

function nativeWorkMode(tianxi, options, agentId) {
  return compactString(
    tianxi.workMode || tianxi.work_mode || options.workMode || (agentId === 'super' ? 'super' : '')
  );
}

function nativeModel(tianxi, options, payload) {
  const agentId = compactString(tianxi.agent_id || options.agentId || '');
  return compactString(
    tianxi.model ||
      tianxi.llm ||
      options.model ||
      (agentId === 'super' ? DEFAULT_TIANXI_QODER_MODEL : '') ||
      payload?.model ||
      ''
  );
}

function nativeQueryOptions(tianxi, options, payload) {
  const model = nativeModel(tianxi, options, payload);
  const source =
    tianxi.options && typeof tianxi.options === 'object' && !Array.isArray(tianxi.options)
      ? tianxi.options
      : {};
  return {
    agentcore_backend: 'qoder',
    backend: compactString(tianxi.backend || options.backend || 'qoder'),
    configPath: compactString(
      tianxi.configPath || tianxi.config_path || options.configPath || DEFAULT_TIANXI_CONFIG_PATH
    ),
    cwd: compactString(tianxi.cwd || options.cwd || DEFAULT_TIANXI_WORKSPACE),
    permissionMode: compactString(
      tianxi.permissionMode || options.permissionMode || 'bypassPermissions'
    ),
    allowedTools: Array.isArray(tianxi.allowedTools)
      ? tianxi.allowedTools
      : [...DEFAULT_TIANXI_ALLOWED_TOOLS],
    disallowedTools: Array.isArray(tianxi.disallowedTools)
      ? tianxi.disallowedTools
      : [...DEFAULT_TIANXI_DISALLOWED_TOOLS],
    ...source,
    ...(model ? { model } : {}),
  };
}

function buildAgentCoreHeader({ sessionId, requestId, tianxi, options } = {}) {
  const header = { session_id: sessionId, request_id: requestId };
  const fields = {
    user_id: tianxi.user_id || options.userId,
    device_id: tianxi.device_id || options.deviceId,
    app_id: tianxi.app_id || options.appId,
    app_version: tianxi.app_version || options.appVersion,
    credentials: tianxi.credentials || options.credentials,
    device_type: tianxi.device_type || options.deviceType,
    resource_id: tianxi.resource_id || options.resourceId,
    role: tianxi.role || options.role,
    tab_id: tianxi.tab_id || options.tabId,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'credentials' && value && typeof value === 'object' && !Array.isArray(value)) {
      header[key] = value;
      continue;
    }
    const text = compactString(value);
    if (text) header[key] = text;
  }
  return header;
}

function buildTianxiAgentCoreFrames(payload, options = {}) {
  const metadata = safeObject(payload && payload.metadata);
  const tianxi = safeObject(metadata.tianxi);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const uuid = typeof options.uuid === 'function' ? options.uuid : randomUUID;
  const sessionId = options.sessionId || tianxi.session_id || uuid();
  const requestId = options.requestId || tianxi.request_id || uuid();
  const deviceId = compactString(tianxi.device_id || options.deviceId || '');
  const deviceInfo = {
    device_id: deviceId,
    device_type: 'pc',
    platform: compactString(tianxi.platform || options.platform || ''),
    version: compactString(tianxi.version || options.version || ''),
  };
  const userId = compactString(tianxi.user_id || options.userId || '');
  const header = buildAgentCoreHeader({ sessionId, requestId, tianxi, options });
  const base = {
    timestamp: String(now()),
    header,
    source: { type: '', id: '' },
    target: { type: '', id: '' },
  };
  const syncFrame = {
    ...base,
    id: uuid(),
    type: 'mcp_server_sync',
    data: {
      mcp_server: [
        {
          mcp_server_id: 'human-in-loop-mcp-server',
          mcp_type: 'user_local_mcp',
          tools: [
            {
              name: 'button_submit_form',
              description: '在表单后提交按钮，等待用户填选表单后，点击按钮提交，返回用户的反馈结果',
            },
          ],
          mcp_server_version: '1.0.0',
        },
      ],
    },
    extend: { device_info: deviceInfo },
  };
  const prompt = extractTianxiPromptText(payload && payload.input);
  const agentId = compactString(tianxi.agent_id || options.agentId || DEFAULT_TIANXI_AGENT_ID);
  const gatewayChannel = nativeGatewayChannel(tianxi, options);
  const workMode = nativeWorkMode(tianxi, options, agentId);
  const model = nativeModel(tianxi, options, payload);
  const queryOptions = nativeQueryOptions(tianxi, options, payload);
  const queryFrame = {
    ...base,
    id: uuid(),
    type: 'query',
    data: { text: prompt, options: queryOptions },
    source: {
      type: 'user',
      id: userId,
    },
    target: {
      type: 'agent',
      id: agentId,
    },
    extend: {
      device_info: deviceInfo,
      channel: compactString(tianxi.channel || options.channel || 'pc'),
      gateway_channel: gatewayChannel,
      gatewayChannel,
      llm: model,
      nickname: compactString(tianxi.nickname || options.nickname || ''),
      raw_query: prompt,
      selected_pkb_files: Array.isArray(tianxi.selected_pkb_files) ? tianxi.selected_pkb_files : [],
      custom_context: truncateText(payload && payload.instructions, MAX_CONTEXT_CHARS),
      ...(workMode ? { workMode } : {}),
    },
  };
  return { sessionId, requestId, frames: [syncFrame, queryFrame] };
}

function buildTianxiNativeApiQueryFrame(payload, options = {}) {
  const metadata = safeObject(payload && payload.metadata);
  const tianxi = safeObject(metadata.tianxi);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const uuid = typeof options.uuid === 'function' ? options.uuid : randomUUID;
  const sessionId = options.sessionId || tianxi.session_id || uuid();
  const requestId = options.requestId || tianxi.request_id || uuid();
  const userId = compactString(tianxi.user_id || options.userId || '');
  const deviceId = compactString(tianxi.device_id || options.deviceId || '');
  const prompt = extractTianxiPromptText(payload && payload.input);
  const header = buildAgentCoreHeader({ sessionId, requestId, tianxi, options });
  const agentId = compactString(tianxi.agent_id || options.agentId || DEFAULT_TIANXI_AGENT_ID);
  const gatewayChannel = nativeGatewayChannel(tianxi, options);
  const workMode = nativeWorkMode(tianxi, options, agentId);
  const model = nativeModel(tianxi, options, payload);
  const queryOptions = nativeQueryOptions(tianxi, options, payload);
  return {
    channelName: compactString(
      tianxi.channel_name || options.channelName || DEFAULT_TIANXI_CHANNEL_NAME
    ),
    sessionId,
    requestId,
    frame: {
      id: uuid(),
      type: 'query',
      timestamp: String(now()),
      header,
      data: {
        text: prompt,
        display_text: prompt,
        attachments: Array.isArray(tianxi.attachments) ? tianxi.attachments : [],
        fromChannel: true,
        options: queryOptions,
      },
      source: {
        type: compactString(tianxi.source_type || 'user'),
        id: userId,
      },
      target: {
        type: compactString(tianxi.target_type || 'agent'),
        id: agentId,
      },
      extend: {
        device_info: {
          device_id: deviceId,
          device_type: 'pc',
          platform: compactString(tianxi.platform || options.platform || ''),
          version: compactString(tianxi.version || options.version || ''),
        },
        channel: compactString(tianxi.channel || options.channel || 'agentCore'),
        gateway_channel: gatewayChannel,
        gatewayChannel,
        llm: model,
        nickname: compactString(tianxi.nickname || options.nickname || ''),
        raw_query: prompt,
        selected_pkb_files: Array.isArray(tianxi.selected_pkb_files)
          ? tianxi.selected_pkb_files
          : [],
        custom_context: truncateText(payload && payload.instructions, MAX_CONTEXT_CHARS),
        ...(workMode ? { workMode } : {}),
      },
    },
  };
}

function parseJsonMaybe(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return value;
  if (text[0] !== '{' && text[0] !== '[') return value;
  try {
    return JSON.parse(text);
  } catch (_err) {
    return value;
  }
}

function collectAgentCoreFrames(value, output) {
  const parsed = parseJsonMaybe(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) collectAgentCoreFrames(item, output);
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  if (parsed.type) {
    output.push(parsed);
    return;
  }
  for (const key of ['frame', 'message', 'payload', 'data', 'event']) {
    if (parsed[key] != null) collectAgentCoreFrames(parsed[key], output);
  }
}

function parseTianxiAgentCoreNotify(value) {
  const frames = [];
  collectAgentCoreFrames(value, frames);
  return parseTianxiBridgeFramesPayload(frames);
}

module.exports = {
  DEFAULT_TIANXI_AGENT_ID,
  DEFAULT_TIANXI_CHANNEL_NAME,
  DEFAULT_TIANXI_QODER_MODEL,
  buildTianxiAgentCoreFrames,
  buildTianxiNativeApiQueryFrame,
  extractTianxiPromptText,
  parseTianxiAgentCoreNotify,
};
