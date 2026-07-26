function looksLikeSse(text) {
  return /^\s*(event:|data:)/.test(text);
}

function parseClaudeSseEvent(event) {
  const lines = event.split(/\r?\n/);
  const eventNameLine = lines.find((line) => line.indexOf('event:') === 0);
  const dataLines = lines
    .filter((line) => line.indexOf('data:') === 0)
    .map((line) => line.replace(/^data:\s*/, ''));
  const dataText = dataLines.join('\n');
  let data = null;
  if (dataText && dataText !== '[DONE]') {
    try {
      data = JSON.parse(dataText);
    } catch (err) {}
  }
  return {
    eventName: eventNameLine
      ? eventNameLine.replace(/^event:\s*/, '')
      : data && data.type
        ? data.type
        : 'message_delta',
    dataText,
    data,
  };
}

function resolveSseBlockIndex(data) {
  if (!data || typeof data !== 'object') return undefined;
  if (data.index != null) return data.index;
  if (data.content_block && data.content_block.index != null) return data.content_block.index;
  return undefined;
}

function deltaPartialJson(delta) {
  if (!delta || typeof delta !== 'object') return '';
  if (delta.partial_json != null) return delta.partial_json;
  if (delta.input_json_delta && delta.input_json_delta.partial_json != null)
    return delta.input_json_delta.partial_json;
  if (delta.type === 'tool_use' && delta.input && typeof delta.input === 'object')
    return JSON.stringify(delta.input);
  return '';
}

function extractSseDataPayloads(text) {
  const payloads = [];
  if (!looksLikeSse(text)) return payloads;
  const events = String(text || '').split(/\r?\n\r?\n/);
  for (const event of events) {
    const parsed = parseClaudeSseEvent(event);
    if (parsed.dataText && parsed.dataText !== '[DONE]') payloads.push(parsed.dataText);
  }
  return payloads;
}

module.exports = {
  looksLikeSse,
  parseClaudeSseEvent,
  resolveSseBlockIndex,
  deltaPartialJson,
  extractSseDataPayloads,
};
