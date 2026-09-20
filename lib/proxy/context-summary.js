'use strict';

const { stableHash } = require('./context-cache-planner');

const MAX_SUMMARY_TEXT_CHARS = 1200;
const MAX_SUMMARY_ITEMS = 24;

function compactText(value, limit = MAX_SUMMARY_TEXT_CHARS) {
  const text = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 16)).trimEnd() + ' ...[truncated]';
}

function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (part.type === 'tool_result') return compactText(part.content, 400);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function toolNamesFromMessage(message) {
  const names = [];
  if (!message || typeof message !== 'object') return names;
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const name = call && (call.name || call.function?.name);
    if (name) names.push(String(name));
  }
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block && block.type === 'tool_use' && block.name) names.push(String(block.name));
    if (block && block.type === 'tool_result' && block.tool_use_id) {
      names.push('result:' + String(block.tool_use_id));
    }
  }
  if (message.role === 'tool' && message.tool_call_id) {
    names.push('result:' + String(message.tool_call_id));
  }
  return names;
}

function createConversationSummary(messages, options = {}) {
  const maxItems = Math.max(1, Number(options.maxItems) || MAX_SUMMARY_ITEMS);
  const source = Array.isArray(messages) ? messages : [];
  const facts = [];
  const toolArtifacts = [];
  let lastUser = '';
  let lastAssistant = '';

  for (const message of source) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || '');
    const text = compactText(messageText(message), 600);
    if (role === 'user' && text) {
      lastUser = text;
      facts.push('User: ' + text);
    } else if (role === 'assistant' && text) {
      lastAssistant = text;
      facts.push('Assistant: ' + text);
    }
    const toolNames = toolNamesFromMessage(message);
    for (const name of toolNames) toolArtifacts.push(name);
  }

  const summary = {
    version: 1,
    messageCount: source.length,
    sourceHash: stableHash(source),
    facts: facts.slice(-maxItems),
    toolArtifacts: Array.from(new Set(toolArtifacts)).slice(-maxItems),
    openItems: lastUser ? [lastUser] : [],
    decisions: [],
    safetyBoundaries: ['Summary excludes raw secrets and may omit old verbatim content.'],
    lastExchange: {
      user: lastUser,
      assistant: lastAssistant,
    },
  };
  summary.text = compactText(
    [
      'Conversation summary:',
      ...summary.facts,
      summary.toolArtifacts.length ? 'Tools: ' + summary.toolArtifacts.join(', ') : '',
    ]
      .filter(Boolean)
      .join('\n'),
    options.maxTextChars || MAX_SUMMARY_TEXT_CHARS
  );
  return summary;
}

function summaryToChatMessages(summary) {
  if (!summary || typeof summary !== 'object' || !summary.text) return [];
  return [
    {
      role: 'system',
      content:
        'Earlier conversation history was compacted by the proxy. Use this bounded summary as background, but prefer explicit current user input when it conflicts.\n\n' +
        summary.text,
    },
  ];
}

module.exports = {
  MAX_SUMMARY_ITEMS,
  MAX_SUMMARY_TEXT_CHARS,
  compactText,
  createConversationSummary,
  summaryToChatMessages,
};
