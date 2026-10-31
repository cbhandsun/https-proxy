'use strict';

const { randomUUID } = require('node:crypto');

const HPM_COMPACTION_PREFIX = 'hpm1:';
const MAGPIE_COMPACTION_PREFIX = 'magpie1:';

const CODEX_SUMMARY_PREFIX =
  'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';

const CODEX_COMPACT_PROMPT =
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\nInclude:\n- Current progress and key decisions made\n- Important context, constraints, or user preferences\n- What remains to be done (clear next steps)\n- Any critical data, examples, or references needed to continue\n\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work.';

function estimateTianxiTokens(text) {
  if (typeof text !== 'string' || !text.length) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x2e80 && code <= 0x9fff) cjk++;
    else other++;
  }
  return Math.max(1, Math.ceil(cjk * 0.85 + other / 3.5));
}

function buildTianxiUsage(inputText, outputText) {
  const inputTokens = estimateTianxiTokens(inputText);
  const outputTokens = estimateTianxiTokens(outputText);
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  };
}

function extractItemText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function encodeTianxiCompactionSummary(summary) {
  const normalized = String(summary || '').trim();
  if (!normalized) {
    throw new Error('tianxi_compaction_empty');
  }
  return HPM_COMPACTION_PREFIX + Buffer.from(normalized, 'utf8').toString('base64');
}

function decodeTianxiCompactionText(encryptedContent) {
  if (typeof encryptedContent !== 'string') return null;
  const trimmed = encryptedContent.trim();
  let rawBase64 = null;
  if (trimmed.startsWith(HPM_COMPACTION_PREFIX)) {
    rawBase64 = trimmed.slice(HPM_COMPACTION_PREFIX.length).trim();
  } else if (trimmed.startsWith(MAGPIE_COMPACTION_PREFIX)) {
    rawBase64 = trimmed.slice(MAGPIE_COMPACTION_PREFIX.length).trim();
  } else {
    return null;
  }
  if (!rawBase64 || !/^[A-Za-z0-9+/=_-]+$/.test(rawBase64)) return null;
  try {
    const decoded = Buffer.from(rawBase64, 'base64').toString('utf8').trim();
    if (!decoded || decoded.includes('\uFFFD')) return null;
    return decoded;
  } catch {
    return null;
  }
}

function hasTianxiCompactionTrigger(input) {
  return Array.isArray(input) && input.some((item) => item && item.type === 'compaction_trigger');
}

function expandTianxiCompactionInput(input) {
  if (!Array.isArray(input)) return input;
  const expanded = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') {
      expanded.push(item);
      continue;
    }
    if (item.type === 'compaction' || item.type === 'compaction_summary') {
      const summary = decodeTianxiCompactionText(item.encrypted_content);
      if (!summary) {
        throw new Error('tianxi_native_feature_unsupported');
      }
      expanded.push({
        type: 'message',
        role: 'user',
        content: CODEX_SUMMARY_PREFIX + '\n' + summary,
      });
      continue;
    }
    if (item.type === 'compaction_trigger') {
      continue;
    }
    expanded.push(item);
  }
  return expanded;
}

function extractTouchedFiles(rawSource) {
  if (typeof rawSource !== 'string' || !rawSource) return [];
  const matches = new Set();
  const patchRegex = /\*\*\* (?:Update|Add|Delete) File:\s*([^\r\n]+)/g;
  let match;
  while ((match = patchRegex.exec(rawSource)) !== null) {
    matches.add(match[1].trim());
  }
  const pathRegex = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}/g;
  while ((match = pathRegex.exec(rawSource)) !== null) {
    if (!match[0].startsWith('http/') && !match[0].startsWith('node:')) {
      matches.add(match[0]);
    }
    if (matches.size >= 24) break;
  }
  return [...matches].slice(0, 20);
}

function buildLocalDeterministicSummary(input) {
  const items = Array.isArray(input) ? input : [];
  const userMessages = [];
  const assistantMessages = [];
  const toolActivities = [];
  const touchedFiles = new Set();

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'compaction' || item.type === 'compaction_summary') {
      const prevSummary = decodeTianxiCompactionText(item.encrypted_content);
      if (prevSummary) {
        userMessages.push('[Previous Checkpoint Summary]\n' + prevSummary.slice(0, 2000));
      }
      continue;
    }
    if ((!item.type || item.type === 'message') && item.role === 'user') {
      const text = extractItemText(item.content).trim();
      if (text && !text.startsWith(CODEX_SUMMARY_PREFIX)) {
        userMessages.push(
          text.length > 1200
            ? text.slice(0, 900) + '\n... [truncated] ...\n' + text.slice(-250)
            : text
        );
      }
    } else if (
      (!item.type || item.type === 'message' || item.type === 'assistant') &&
      item.role === 'assistant'
    ) {
      const text = extractItemText(item.content).trim();
      if (text) {
        assistantMessages.push(
          text.length > 800 ? text.slice(0, 600) + ' ... ' + text.slice(-150) : text
        );
      }
    } else if (
      item.type === 'function_call' ||
      item.type === 'custom_tool_call' ||
      item.type === 'tool_call'
    ) {
      const toolName = item.namespace ? `${item.namespace}.${item.name}` : item.name || 'tool';
      const rawArgs =
        typeof item.input === 'string'
          ? item.input
          : typeof item.arguments === 'string'
            ? item.arguments
            : '';
      for (const file of extractTouchedFiles(rawArgs)) {
        if (touchedFiles.size < 24) touchedFiles.add(file);
      }
      const snippet = rawArgs.replace(/\s+/g, ' ').trim().slice(0, 240);
      toolActivities.push(`- Called \`${toolName}\`${snippet ? `: ${snippet}` : ''}`);
    } else if (
      item.type === 'function_call_output' ||
      item.type === 'custom_tool_call_output' ||
      item.type === 'tool_call_output'
    ) {
      const outText =
        typeof item.output === 'string'
          ? item.output
          : extractItemText(item.output) || extractItemText(item.content) || '';
      const snippet = outText.replace(/\s+/g, ' ').trim().slice(0, 260);
      if (snippet) {
        toolActivities.push(`  -> Output: ${snippet}`);
      }
    }
  }

  const sections = ['## Context Checkpoint Summary'];
  if (userMessages.length > 0) {
    const firstTask = userMessages[0];
    const recentUser = userMessages.length > 1 ? userMessages.slice(-2) : [];
    sections.push('### User Goal & Instructions\n' + firstTask);
    if (recentUser.length > 0) {
      sections.push('### Recent User Follow-ups\n' + recentUser.join('\n\n'));
    }
  }
  if (touchedFiles.size > 0) {
    sections.push('### Referenced & Modified Files\n- ' + [...touchedFiles].join('\n- '));
  }
  if (toolActivities.length > 0) {
    sections.push('### Recent Tool Activity\n' + toolActivities.slice(-14).join('\n'));
  }
  if (assistantMessages.length > 0) {
    sections.push('### Latest Assistant Findings\n' + assistantMessages.slice(-3).join('\n\n'));
  }
  sections.push(
    '### Next Steps\nContinue from the latest tool outputs and assistant findings above without repeating completed commands.'
  );
  return sections.join('\n\n');
}

function buildPlainCompactPrompt(input, maxChars = 24000) {
  const summarySeed = buildLocalDeterministicSummary(input);
  const prompt = `${summarySeed}\n\n${CODEX_COMPACT_PROMPT}`;
  return prompt.length > maxChars ? prompt.slice(0, maxChars) : prompt;
}

function createTianxiCompactionGuard({
  maxFailures = 3,
  cooldownMs = 5 * 60 * 1000,
  now = Date.now,
} = {}) {
  const failures = new Map();

  function sweep() {
    const current = now();
    for (const [key, entry] of failures.entries()) {
      if (current >= entry.until) failures.delete(key);
    }
  }

  return {
    check(key) {
      sweep();
      const entry = failures.get(key);
      if (entry && entry.count >= maxFailures && now() < entry.until) {
        const err = new Error('tianxi_compaction_cooldown');
        err.code = 'tianxi_compaction_cooldown';
        throw err;
      }
    },
    recordFailure(key) {
      sweep();
      const current = now();
      const prev = failures.get(key);
      const count = prev && current < prev.until ? prev.count + 1 : 1;
      failures.set(key, { count, until: current + cooldownMs });
    },
    recordSuccess(key) {
      failures.delete(key);
    },
  };
}

function buildTianxiCompactionResponse(model, summaryText, { standalone = false, inputText = '' } = {}) {
  const encryptedContent = encodeTianxiCompactionSummary(summaryText);
  const compactionItem = {
    id: 'cmp_' + randomUUID().replaceAll('-', ''),
    type: 'compaction',
    encrypted_content: encryptedContent,
  };
  const usage = buildTianxiUsage(inputText || summaryText, summaryText);
  if (standalone) {
    return {
      id: 'resp_' + randomUUID().replaceAll('-', ''),
      object: 'response.compaction',
      created_at: Math.floor(Date.now() / 1000),
      model,
      output: [compactionItem],
      usage,
    };
  }
  return {
    id: 'resp_' + randomUUID().replaceAll('-', ''),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: 'completed',
    output: [compactionItem],
    output_text: '',
    usage,
    error: null,
    incomplete_details: null,
    parallel_tool_calls: false,
  };
}

module.exports = {
  HPM_COMPACTION_PREFIX,
  MAGPIE_COMPACTION_PREFIX,
  CODEX_SUMMARY_PREFIX,
  CODEX_COMPACT_PROMPT,
  estimateTianxiTokens,
  buildTianxiUsage,
  encodeTianxiCompactionSummary,
  decodeTianxiCompactionText,
  hasTianxiCompactionTrigger,
  expandTianxiCompactionInput,
  buildLocalDeterministicSummary,
  buildPlainCompactPrompt,
  createTianxiCompactionGuard,
  buildTianxiCompactionResponse,
};
