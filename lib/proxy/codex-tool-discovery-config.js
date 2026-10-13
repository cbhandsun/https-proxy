'use strict';

const { TOOL_DISCOVERY_HEADER, TOOL_DISCOVERY_CAPABILITY } = require('./context-tool-catalog');
const PROVIDER = 'model_providers.custom';
const HEADERS = PROVIDER + '.http_headers';
const MAX_CONFIG_BYTES = 1024 * 1024;
const HEADER_KEY = /^\s*(?:"x-hpm-tool-discovery"|'x-hpm-tool-discovery'|x-hpm-tool-discovery)\s*=/;
const HEADER_VALUE =
  /^\s*(?:"x-hpm-tool-discovery"|'x-hpm-tool-discovery'|x-hpm-tool-discovery)\s*=\s*(?:"hpm-function-discovery-v1"|'hpm-function-discovery-v1')\s*(?:#.*)?$/;

function invalid() {
  const error = new TypeError(
    'Unsupported Codex tool-discovery configuration; existing settings were not changed'
  );
  error.code = 'invalid_codex_tool_discovery';
  error.statusCode = 400;
  return error;
}
function validateCodexToolDiscoveryOption(value) {
  if (value !== undefined && typeof value !== 'boolean') throw invalid();
  return value;
}
function validateCodexToolDiscoveryOptions(options) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    throw invalid();
  const descriptor = Object.getOwnPropertyDescriptor(options, 'toolDiscovery');
  if (descriptor && !Object.hasOwn(descriptor, 'value')) throw invalid();
  return validateCodexToolDiscoveryOption(descriptor?.value);
}
function multilineState(line, delimiter) {
  let quote;
  for (let index = 0; index < line.length; index++) {
    if (delimiter) {
      if (delimiter === '"""' && line[index] === '\\') index++;
      else if (line.slice(index, index + 3) === delimiter) {
        delimiter = undefined;
        index += 2;
      }
    } else if (quote) {
      if (quote === '"' && line[index] === '\\') index++;
      else if (line[index] === quote) quote = undefined;
    } else if (line[index] === '#') break;
    else if (['"', "'"].includes(line[index])) {
      if (line.slice(index, index + 3) === line[index].repeat(3)) {
        delimiter = line[index].repeat(3);
        index += 2;
      } else quote = line[index];
    }
  }
  if (quote) throw invalid();
  return delimiter;
}
function inspect(content) {
  if (
    typeof content !== 'string' ||
    Buffer.byteLength(content) > MAX_CONFIG_BYTES ||
    content.includes('\0')
  )
    throw invalid();
  const lines = content.split('\n');
  let section = '',
    headerStart = -1,
    headerEnd = lines.length,
    tables = 0;
  let delimiter;
  const keys = [],
    inlineHeaders = [];
  for (const [index, line] of lines.entries()) {
    const insideString = !!delimiter;
    delimiter = multilineState(line, delimiter);
    if (insideString) continue;
    const table = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (table) {
      if (section === HEADERS) headerEnd = index;
      section = table[1].trim();
      if (section === HEADERS) {
        headerStart = index;
        tables++;
      }
    } else if (section === HEADERS && HEADER_KEY.test(line)) keys.push(index);
    else if (section === PROVIDER && /^\s*http_headers\s*=/.test(line)) inlineHeaders.push(line);
  }
  if (delimiter) throw invalid();
  if (tables > 1 || keys.length > 1 || inlineHeaders.length > 1 || (tables && inlineHeaders.length))
    throw invalid();
  if (inlineHeaders.length && !/^\s*http_headers\s*=\s*\{.*\}\s*(?:#.*)?$/.test(inlineHeaders[0]))
    throw invalid();
  return {
    lines,
    headerStart,
    headerEnd,
    keys,
    inlineHeaders,
    enabled: keys.length === 1 && HEADER_VALUE.test(lines[keys[0]]),
  };
}
// Narrow managed TOML editor, not a general parser. User inline maps are kept
// byte-for-byte on ordinary reapply and never rewritten by a discovery toggle.
function configureCodexToolDiscovery(content, option) {
  option = validateCodexToolDiscoveryOption(option);
  const state = inspect(content);
  if (option !== undefined && state.inlineHeaders.length) throw invalid();
  if (option === undefined)
    return { content, enabled: state.enabled, providerHeadersLine: state.inlineHeaders[0] };
  const line = `"${TOOL_DISCOVERY_HEADER}" = "${TOOL_DISCOVERY_CAPABILITY}"`;
  if (state.keys.length) {
    if (option) state.lines[state.keys[0]] = line;
    else state.lines.splice(state.keys[0], 1);
  } else if (option && state.headerStart >= 0) state.lines.splice(state.headerEnd, 0, line);
  else if (option) state.lines.push('', `[${HEADERS}]`, line, '');
  return { content: state.lines.join('\n'), enabled: option, providerHeadersLine: undefined };
}
function readCodexToolDiscoveryStatus(content) {
  try {
    const state = inspect(content);
    return { enabled: state.enabled, editable: state.inlineHeaders.length === 0 };
  } catch {
    return { enabled: false, editable: false };
  }
}

module.exports = {
  configureCodexToolDiscovery,
  readCodexToolDiscoveryStatus,
  validateCodexToolDiscoveryOption,
  validateCodexToolDiscoveryOptions,
};
