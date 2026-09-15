const { optimizeContextMessages } = require('../context-optimizer');
('use strict');

const {
  buildWorkBuddyDesktopHeaders,
  sanitizeWorkBuddyChatBody,
} = require('../workbuddy-official');

function injectPromptPreset(chatBody, preset) {
  if (!chatBody || typeof chatBody !== 'object' || !preset || !preset.content) return;
  const content = String(preset.content).trim();
  if (!content) return;
  const prefix = `[预设指令: ${preset.name || preset.id || 'Custom'}]\n${content}\n\n`;
  if (!Array.isArray(chatBody.messages)) {
    chatBody.messages = [];
  }
  const firstMsg = chatBody.messages[0];
  if (firstMsg && (firstMsg.role === 'system' || firstMsg.role === 'developer')) {
    if (typeof firstMsg.content === 'string') {
      if (!firstMsg.content.includes(content)) {
        firstMsg.content = prefix + firstMsg.content;
      }
    }
  } else {
    chatBody.messages.unshift({
      role: 'system',
      content: `${prefix}`.trim(),
    });
  }
}

function prepareConvertedChatBody(prepared, chatBody, targetModel, options = {}) {
  if (!chatBody || typeof chatBody !== 'object') return chatBody;

  const activePreset =
    (options && options.promptPreset) ||
    (prepared && (prepared.activePromptPreset || prepared.promptPreset));
  if (activePreset) {
    injectPromptPreset(chatBody, activePreset);
  }

  const isWorkBuddy =
    (prepared && prepared.authProvider === 'workbuddy') ||
    (prepared && prepared.profile && prepared.profile.protocol === 'workbuddy');
  if (isWorkBuddy) {
    sanitizeWorkBuddyChatBody(chatBody, { targetModel });
  } else if (
    Array.isArray(chatBody.messages) &&
    prepared &&
    prepared.profile &&
    prepared.profile.protocol !== 'openai'
  ) {
    if (prepared.profile.optimizeContext === true) {
      const { messages } = optimizeContextMessages(
        chatBody.messages,
        options.optimizerOptions || {}
      );
      chatBody.messages = messages;
    }
    for (const msg of chatBody.messages) {
      if (msg && msg.role === 'developer') {
        msg.role = 'system';
      }
    }
  }
  return chatBody;
}

function createConvertedChatRequest(prepared, target, apiKey, requestBody) {
  if (!Buffer.isBuffer(requestBody)) throw new TypeError('requestBody must be a Buffer');
  const profile = (prepared && prepared.profile) || {};
  const headers = {
    'content-type': 'application/json',
    'content-length': requestBody.length,
  };
  if (apiKey) headers.authorization = 'Bearer ' + apiKey;

  const effectiveUid =
    (prepared && prepared.workbuddyAuth && prepared.workbuddyAuth.uid) || profile.uid;
  if (effectiveUid && (prepared.authProvider === 'workbuddy' || profile.protocol === 'workbuddy')) {
    let seed = (prepared && prepared.reqId) || null;
    try {
      const parsed = JSON.parse(requestBody.toString('utf8'));
      if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
        const firstUser = parsed.messages.find((m) => m && m.role === 'user');
        if (firstUser && firstUser.content) {
          seed =
            typeof firstUser.content === 'string'
              ? firstUser.content
              : JSON.stringify(firstUser.content);
        }
      }
    } catch (_) {}
    Object.assign(headers, buildWorkBuddyDesktopHeaders({ uid: effectiveUid, seed }));
  }

  const auditHeaders = {
    'content-type': headers['content-type'],
    'content-length': headers['content-length'],
  };
  if (headers.authorization) auditHeaders.authorization = '[redacted]';
  if (headers['x-user-id']) auditHeaders['x-user-id'] = '[redacted]';

  return {
    headers,
    audit: {
      method: 'POST',
      path: target.path + '/chat/completions',
      targetHost: target.hostname,
      targetProtocol: target.protocol,
      headers: auditHeaders,
      body: '',
      bodyBytes: requestBody.length,
    },
  };
}

module.exports = { createConvertedChatRequest, prepareConvertedChatBody, injectPromptPreset };
