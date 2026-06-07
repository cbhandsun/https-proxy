function normalizeToolName(name) {
  let normalized = String(name || '').trim();
  normalized = normalized.replace(/^functions\./i, '');
  normalized = normalized.replace(/^function\./i, '');
  normalized = normalized.replace(/^tools\./i, '');
  normalized = normalized.replace(/^tool[:._-]+/i, '');
  normalized = normalized.replace(/^default_api[:._-]+/i, '');
  normalized = normalized.replace(/^default_api__+/i, '');
  return normalized;
}

function fallbackRequiredToolArgs(name) {
  const normalized = normalizeToolName(name).toLowerCase();
  if (normalized === 'bash' || normalized === 'powershell' || normalized === 'powershell.exe') return ['command'];
  if (normalized === 'grep' || normalized === 'glob') return ['pattern'];
  if (normalized === 'read') return ['file_path'];
  if (normalized === 'edit') return ['file_path', 'old_string', 'new_string'];
  if (normalized === 'write') return ['file_path', 'content'];
  return [];
}

function findDeclaredTool(name, tools) {
  const toolName = normalizeToolName(name).toLowerCase();
  return Array.isArray(tools) ? tools.find((item) => item && normalizeToolName(item.name).toLowerCase() === toolName) : null;
}

function hasMeaningfulArgs(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.length > 0;
  return Object.keys(value).length > 0;
}

function parseGeminiToolArgs(rawArgs) {
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return parseGeminiToolArgs(parsed);
    } catch (err) {
      return { input: rawArgs };
    }
  }
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return {};
  for (const key of ['args', 'arguments', 'parameters', 'input']) {
    if (hasMeaningfulArgs(rawArgs[key])) return parseGeminiToolArgs(rawArgs[key]);
  }
  return rawArgs;
}

function geminiFunctionCallArgs(call) {
  if (!call || typeof call !== 'object') return {};
  const merged = { ...parseGeminiToolArgs(call.args) };
  for (const key of ['arguments', 'parameters', 'input']) {
    const extra = parseGeminiToolArgs(call[key]);
    if (Object.keys(extra).length > 0) Object.assign(merged, extra);
  }
  return merged;
}

function toolRetryText(toolName, error) {
  return '[Gemini tool call needs retry: ' + toolName + ' ' + error + '. Please call the same tool again with complete arguments.]';
}

function compactOptionalEmptyArgs(args, required) {
  const requiredSet = new Set(required || []);
  const compacted = {};
  Object.keys(args || {}).forEach((key) => {
    if (args[key] === '' && !requiredSet.has(key)) return;
    compacted[key] = args[key];
  });
  return compacted;
}

function cleanToolArgs(name, args, required) {
  const requiredNames = Array.from(new Set([...(required || []), ...fallbackRequiredToolArgs(name)]));
  return compactOptionalEmptyArgs(args || {}, requiredNames);
}

function stripEmptyOptionalToolArgs(name, args) {
  return cleanToolArgs(name, args);
}

function normalizeBashCommandArgs(args) {
  if (!args || typeof args !== 'object' || typeof args.command !== 'string') return args;
  const command = args.command.trim();
  const match = command.match(/^ls\s+-R\s+([A-Za-z0-9_./ -]+)$/);
  if (!match) return args;
  const paths = match[1].trim().split(/\s+/).filter(Boolean);
  if (paths.length < 2 || paths.some((item) => item.startsWith('-') || item.includes('..'))) return args;
  return {
    ...args,
    command: 'for d in ' + paths.map((item) => JSON.stringify(item)).join(' ') + '; do [ -d "$d" ] && ls -R "$d"; done',
  };
}

function sanitizeGeminiToolCall(toolCall, tools) {
  const toolName = normalizeToolName(toolCall && toolCall.name);
  if (!toolName) return { error: 'missing tool name', text: toolRetryText('unknown', 'is missing tool name') };

  const rawArgs = geminiFunctionCallArgs(toolCall);
  const tool = findDeclaredTool(toolName, tools);
  if (Array.isArray(tools) && tools.length > 0 && !tool) {
    return { error: 'undeclared tool ' + toolName, text: toolRetryText(toolName, 'is not available in the current tool list') };
  }
  const schema = tool && tool.input_schema;
  const schemaRequired = schema && Array.isArray(schema.required) ? schema.required : [];
  const fallbackRequired = fallbackRequiredToolArgs(toolName);
  const required = Array.from(new Set([...schemaRequired, ...fallbackRequired]));
  const args = compactOptionalEmptyArgs(rawArgs, required);
  const missing = required.filter((name) => args[name] == null || args[name] === '');
  if (missing.length > 0) {
    const error = 'is missing required argument' + (missing.length > 1 ? 's' : '') + ': ' + missing.join(', ');
    return { error: 'missing required tool args for ' + toolName + ': ' + missing.join(', '), text: toolRetryText(toolName, error) };
  }
  if (!tool && fallbackRequired.length === 0 && Object.keys(args).length === 0) {
    return { error: 'empty args for unknown tool ' + toolName, text: toolRetryText(toolName, 'has empty arguments') };
  }
  return { name: toolName, args: normalizeBashCommandArgs(args) };
}

function toolCallValidationError(toolCall, tools) {
  return sanitizeGeminiToolCall(toolCall, tools).error || null;
}

module.exports = {
  normalizeToolName,
  fallbackRequiredToolArgs,
  findDeclaredTool,
  hasMeaningfulArgs,
  parseGeminiToolArgs,
  geminiFunctionCallArgs,
  toolRetryText,
  compactOptionalEmptyArgs,
  cleanToolArgs,
  stripEmptyOptionalToolArgs,
  normalizeBashCommandArgs,
  sanitizeGeminiToolCall,
  toolCallValidationError,
};
