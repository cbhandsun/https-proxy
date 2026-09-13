export function createChatMessage(role, content = '', thinking = '') {
  return {
    id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    role,
    content,
    thinking,
    time: Date.now(),
  };
}

export function parseStreamChunk(chunkText) {
  const lines = chunkText.split(/\r?\n/);
  const result = {
    textDelta: '',
    thinkingDelta: '',
    isDone: false,
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) continue;
    const dataStr = trimmed.slice(5).trim();
    if (dataStr === '[DONE]') {
      result.isDone = true;
      continue;
    }
    try {
      const parsed = JSON.parse(dataStr);
      if (parsed.choices && parsed.choices[0]) {
        const delta = parsed.choices[0].delta || {};
        if (delta.content) result.textDelta += delta.content;
        if (delta.reasoning_content) result.thinkingDelta += delta.reasoning_content;
        if (delta.reasoning) result.thinkingDelta += delta.reasoning;
      }
      if (parsed.type === 'content_block_delta') {
        const delta = parsed.delta || {};
        if (delta.type === 'text_delta' && delta.text) result.textDelta += delta.text;
        if (delta.type === 'thinking_delta' && delta.thinking)
          result.thinkingDelta += delta.thinking;
      }
    } catch (_) {
      // Ignore incomplete chunk
    }
  }

  return result;
}

export function calculateGenerationStats(startTime, firstTokenTime, totalTokens = 0) {
  const now = Date.now();
  const ttftMs = firstTokenTime ? firstTokenTime - startTime : 0;
  const durationMs = Math.max(1, now - startTime);
  const durationSec = durationMs / 1000;
  const tokensPerSec = totalTokens > 0 ? (totalTokens / durationSec).toFixed(1) : '0.0';

  return {
    ttftMs,
    durationMs,
    totalTokens,
    tokensPerSec,
  };
}

export function estimateTokenCount(text) {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.max(1, Math.round(chineseChars * 1.5 + otherChars * 0.3));
}
