function geminiSafeToolName(name) {
  const normalized = String(name || '').trim();
  if (/^[a-zA-Z0-9_]{1,64}$/.test(normalized)) return normalized;
  let safe = normalized.replace(/[^a-zA-Z0-9_]/g, '_');
  if (!/^[a-zA-Z]/.test(safe)) safe = 'tool_' + safe;
  if (safe.length > 64) safe = safe.slice(0, 64);
  return safe;
}

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
  if (normalized === 'bash' || normalized === 'powershell' || normalized === 'powershell.exe')
    return ['command'];
  if (normalized === 'grep' || normalized === 'glob') return ['pattern'];
  if (normalized === 'read') return ['file_path'];
  if (normalized === 'edit') return ['file_path', 'old_string', 'new_string'];
  if (normalized === 'write') return ['file_path', 'content'];
  return [];
}

function findDeclaredTool(name, tools) {
  const rawName = String(name || '')
    .trim()
    .toLowerCase();
  const toolName = normalizeToolName(name).toLowerCase();
  return Array.isArray(tools)
    ? tools.find((item) => {
        if (!item || !item.name) return false;
        const declaredRaw = String(item.name).trim().toLowerCase();
        const declaredNorm = normalizeToolName(item.name).toLowerCase();
        const declaredSafe = geminiSafeToolName(item.name).toLowerCase();
        return (
          declaredRaw === rawName ||
          declaredNorm === toolName ||
          declaredSafe === rawName ||
          declaredSafe === toolName ||
          geminiSafeToolName(toolName) === declaredSafe
        );
      })
    : null;
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
  return (
    '[Gemini tool call needs retry: ' +
    toolName +
    ' ' +
    error +
    '. Please call the same tool again with complete arguments.]'
  );
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

function normalizeFilePathAliases(args, required) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const next = { ...args };
  const requiredSet = new Set(required || []);
  const pathValue = [next.file_path, next.path, next.filePath, next.file].find(
    (value) => typeof value === 'string' && value.trim()
  );
  if (!pathValue) return next;
  if (requiredSet.has('file_path') && (next.file_path == null || next.file_path === '')) {
    next.file_path = pathValue;
  }
  if (requiredSet.has('path') && (next.path == null || next.path === '')) {
    next.path = pathValue;
  }
  return next;
}

function cleanToolArgs(name, args, required) {
  const requiredNames = Array.from(
    new Set([...(required || []), ...fallbackRequiredToolArgs(name)])
  );
  return compactOptionalEmptyArgs(
    normalizeFilePathAliases(args || {}, requiredNames),
    requiredNames
  );
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
  if (paths.length < 2 || paths.some((item) => item.startsWith('-') || item.includes('..')))
    return args;
  return {
    ...args,
    command:
      'for d in ' +
      paths.map((item) => JSON.stringify(item)).join(' ') +
      '; do [ -d "$d" ] && ls -R "$d"; done',
  };
}

function declaredToolMatchForArgs(currentToolName, rawArgs, tools) {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return null;
  const providedNames = Object.keys(rawArgs);
  if (providedNames.length === 0 || !Array.isArray(tools)) return null;

  const currentName = normalizeToolName(currentToolName).toLowerCase();
  const matches = tools.flatMap((candidate) => {
    const declaredName = String((candidate && candidate.name) || '').trim();
    const candidateName = normalizeToolName(declaredName);
    if (!declaredName || !candidateName || candidateName.toLowerCase() === currentName) return [];
    const schema = candidate && candidate.input_schema;
    const properties = schema && schema.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];

    const required = Array.from(
      new Set([
        ...(Array.isArray(schema.required) ? schema.required : []),
        ...fallbackRequiredToolArgs(candidateName),
      ])
    );
    if (required.length === 0) return [];
    const args = compactOptionalEmptyArgs(normalizeFilePathAliases(rawArgs, required), required);
    if (required.some((name) => args[name] == null || args[name] === '')) return [];
    if (Object.keys(args).some((name) => !Object.prototype.hasOwnProperty.call(properties, name))) {
      return [];
    }
    return [{ name: declaredName, args }];
  });

  return matches.length === 1 ? matches[0] : null;
}

function repairToolCallAsExec(toolName, rawArgs, tools) {
  if (!toolName || !Array.isArray(tools)) return null;
  const execTool = findDeclaredTool('exec', tools) || findDeclaredTool('js', tools);
  if (!execTool) return null;

  const safeProp = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(toolName)
    ? `tools.${toolName}`
    : `tools[${JSON.stringify(toolName)}]`;
  const serializedArgs =
    rawArgs && typeof rawArgs === 'object' && Object.keys(rawArgs).length > 0
      ? JSON.stringify(rawArgs)
      : '';
  const code = `await ${safeProp}(${serializedArgs});`;
  return {
    name: execTool.name,
    args: { input: code, code },
    repairedFrom: toolName,
  };
}

function toolNotAvailableText(toolName, tools) {
  const declared = Array.isArray(tools) ? tools.map((t) => t && t.name).filter(Boolean) : [];
  const listMsg = declared.length > 0 ? ' Available tools: ' + declared.join(', ') + '.' : '';
  return (
    '[Gemini tool call error: ' +
    toolName +
    ' is not available in the current tool list.' +
    listMsg +
    ' Do NOT call ' +
    toolName +
    ' again. Please use only declared tools or respond in plain text.]'
  );
}

function sanitizeGeminiToolCall(toolCall, tools) {
  const toolName = normalizeToolName(toolCall && toolCall.name);
  if (!toolName)
    return { error: 'missing tool name', text: toolRetryText('unknown', 'is missing tool name') };

  const rawArgs = geminiFunctionCallArgs(toolCall);
  const tool = findDeclaredTool(toolName, tools);
  if (Array.isArray(tools) && tools.length > 0 && !tool) {
    const repairedMatch = declaredToolMatchForArgs(toolName, rawArgs, tools);
    if (repairedMatch) {
      return {
        name: repairedMatch.name,
        args: normalizeBashCommandArgs(repairedMatch.args),
        repairedFrom: toolName,
      };
    }
    const repairedExec = repairToolCallAsExec(toolName, rawArgs, tools);
    if (repairedExec) return repairedExec;

    return {
      error: 'undeclared tool ' + toolName,
      text: toolNotAvailableText(toolName, tools),
    };
  }
  const schema = tool && tool.input_schema;
  const schemaRequired = schema && Array.isArray(schema.required) ? schema.required : [];
  const fallbackRequired = fallbackRequiredToolArgs(toolName);
  const required = Array.from(new Set([...schemaRequired, ...fallbackRequired]));
  const args = compactOptionalEmptyArgs(normalizeFilePathAliases(rawArgs, required), required);
  const missing = required.filter((name) => args[name] == null || args[name] === '');
  if (missing.length > 0) {
    const repaired = declaredToolMatchForArgs(toolName, rawArgs, tools);
    if (repaired) {
      return {
        name: repaired.name,
        args: normalizeBashCommandArgs(repaired.args),
        repairedFrom: toolName,
      };
    }
    const error =
      'is missing required argument' + (missing.length > 1 ? 's' : '') + ': ' + missing.join(', ');
    return {
      error: 'missing required tool args for ' + toolName + ': ' + missing.join(', '),
      text: toolRetryText(toolName, error),
    };
  }
  if (!tool && fallbackRequired.length === 0 && Object.keys(args).length === 0) {
    return {
      error: 'empty args for unknown tool ' + toolName,
      text: toolRetryText(toolName, 'has empty arguments'),
    };
  }
  return {
    name: tool && typeof tool.name === 'string' ? tool.name : toolName,
    args: normalizeBashCommandArgs(args),
  };
}

function toolCallValidationError(toolCall, tools) {
  return sanitizeGeminiToolCall(toolCall, tools).error || null;
}

module.exports = {
  geminiSafeToolName,
  normalizeToolName,
  fallbackRequiredToolArgs,
  findDeclaredTool,
  hasMeaningfulArgs,
  parseGeminiToolArgs,
  geminiFunctionCallArgs,
  toolRetryText,
  compactOptionalEmptyArgs,
  normalizeFilePathAliases,
  cleanToolArgs,
  stripEmptyOptionalToolArgs,
  normalizeBashCommandArgs,
  declaredToolMatchForArgs,
  sanitizeGeminiToolCall,
  toolCallValidationError,
};
