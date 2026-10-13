'use strict';

const fs = require('node:fs');
const path = require('node:path').win32;
const { clientReadCommand, clientSearchCommand } = require('./tianxi-client-read-commands');
const SERVER = 'codex_readonly';
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const ARGUMENT_REASONS = Object.freeze({
  action_shape: '工具调用结构无效。',
  tool_name: '工具名称不受支持。',
  argument_shape: '工具参数必须是对象。',
  unknown_field: '工具参数包含未声明的字段。',
  workspace: '工具工作区不可用。',
  path_format: '路径格式无效。',
  outside_workspace: '路径超出当前工作区，或链接指向工作区外。',
  path_missing: '指定的文件或目录不存在。',
  path_unavailable: '文件或目录无法访问。',
  path_type: '文件和目录类型不符合当前工具要求。',
  read_range: '读取行号或行数无效：offset 必须为 1 到 100000，limit 为 1 到 2000 的整数。',
  read_tail: 'tail 必须为 1 到 2000 的整数，且不能与 offset 或 limit 同时使用。',
  option_type: '范围和元数据选项必须为布尔值。',
  ignored_scope: '搜索被忽略的文件必须指定工作区内的具体文件或子目录，不能使用工作区根目录。',
  protected_scope: '扩展搜索范围不能指向依赖、Git 元数据、环境凭据或密钥文件。',
  search_pattern: '搜索条件须为 1 到 1024 个字符的单行文本。',
});
const SINGLE_LINE_SCHEMA = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: 1024,
  pattern: '^[^\\u0000-\\u001f\\u007f]+(?![\\s\\S])',
});
function invalid(reason) {
  const error = new Error('tianxi_client_tool_arguments_invalid');
  if (Object.hasOwn(ARGUMENT_REASONS, reason)) error.argumentReason = reason;
  throw error;
}
function tianxiClientArgumentFailure(error) {
  try {
    for (let depth = 0, cause = error; depth < 3 && cause && typeof cause === 'object'; depth++) {
      const reason = Object.getOwnPropertyDescriptor(cause, 'argumentReason')?.value;
      if (typeof reason === 'string' && Object.hasOwn(ARGUMENT_REASONS, reason))
        return { reason, message: ARGUMENT_REASONS[reason] };
      cause = Object.getOwnPropertyDescriptor(cause, 'cause')?.value;
    }
  } catch {
    // Never execute error accessors or expose arbitrary exception metadata.
  }
  return null;
}
const text = (value, maximum) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maximum &&
  ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
function inside(root, value) {
  const relative = path.relative(root, value);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..\\') && !path.isAbsolute(relative))
  );
}
const definitions = [
  {
    name: 'read_file',
    description:
      'Read a UTF-8 workspace file. offset is one-based. Use tail for log endings (exclusive with offset/limit). Use include_metadata for returned line count and remaining-range indicators; tail start_line is unknown. At most 2000 lines; output may be truncated, so prefer 80 lines.',
    inputSchema: {
      type: 'object',
      properties: {
        progress: {
          ...SINGLE_LINE_SCHEMA,
          maxLength: 320,
          description:
            'Brief user-facing explanation of what you will check and why. Required for new calls. No private reasoning or credentials.',
        },
        file_path: SINGLE_LINE_SCHEMA,
        offset: { type: 'integer', minimum: 1, maximum: 100000 },
        limit: { type: 'integer', minimum: 1, maximum: 2000 },
        tail: { type: 'integer', minimum: 1, maximum: 2000 },
        include_metadata: { type: 'boolean' },
      },
      required: ['file_path', 'progress'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_files',
    description:
      'Find workspace files using a glob pattern; use ** for recursive discovery. Hidden files are excluded by default; rg positive globs can override ignore rules for matching files. No match does not prove absence. include_hidden reveals CI files; include_ignored requires an explicit subdirectory. Expanded discovery excludes dependencies, .git, .env and key files. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        progress: { ...SINGLE_LINE_SCHEMA, maxLength: 320 },
        pattern: SINGLE_LINE_SCHEMA,
        path: SINGLE_LINE_SCHEMA,
        include_hidden: { type: 'boolean' },
        include_ignored: { type: 'boolean' },
      },
      required: ['pattern', 'progress'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_text',
    description:
      'Search literal text, not regex. Directory searches exclude hidden/ignored files by default. An explicit file path can search a known log. include_hidden reveals CI files; include_ignored requires an explicit file or subdirectory. Expanded discovery excludes dependencies, .git, .env and key files. Empty results do not prove absence; output can be truncated. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        progress: { ...SINGLE_LINE_SCHEMA, maxLength: 320 },
        pattern: SINGLE_LINE_SCHEMA,
        path: SINGLE_LINE_SCHEMA,
        include_hidden: { type: 'boolean' },
        include_ignored: { type: 'boolean' },
      },
      required: ['pattern', 'progress'],
      additionalProperties: false,
    },
  },
];

function tianxiClientReadMetadata(nativeTools) {
  return {
    ...nativeTools,
    allowedTools: definitions.map((tool) => `mcp__${SERVER}__${tool.name}`),
    disallowedTools: [
      ...new Set([
        ...nativeTools.disallowedTools,
        'Read',
        'Glob',
        'Grep',
        'LS',
        'AskUserQuestion',
        'TodoWrite',
        'TodoRead',
        'EnterPlanMode',
        'ExitPlanMode',
      ]),
    ],
    options: {
      customMcpServers: {
        [SERVER]: {
          exec_mode: 'local',
          name: SERVER,
          version: '1.0.0',
          tools: JSON.parse(JSON.stringify(definitions)),
        },
      },
    },
  };
}

function compileTianxiClientRead(action, cwd, fileSystem = fs) {
  if (!record(action) || action.mcpServerName !== SERVER) invalid('action_shape');
  if (!text(cwd, 1024) || !/^[A-Za-z]:\\/.test(cwd)) invalid('workspace');
  const definition = definitions.find(
    (tool) => action.name === tool.name || action.name === `mcp__${SERVER}__${tool.name}`
  );
  const args = action.parameters;
  if (!definition) invalid('tool_name');
  if (!record(args)) invalid('argument_shape');
  if (Object.hasOwn(args, 'progress')) {
    const progress = Object.getOwnPropertyDescriptor(args, 'progress')?.value;
    if (!text(progress, 320) || !progress.trim()) invalid('argument_shape');
  }
  if (Object.keys(args).some((key) => !Object.hasOwn(definition.inputSchema.properties, key)))
    invalid('unknown_field');
  for (const key of ['include_hidden', 'include_ignored', 'include_metadata'])
    if (Object.hasOwn(args, key) && typeof args[key] !== 'boolean') invalid('option_type');
  let root;
  try {
    root = path.normalize(fileSystem.realpathSync.native(cwd));
  } catch {
    invalid('workspace');
  }
  function target(value, kind) {
    if (
      !text(value, 1024) ||
      value.slice(/^[A-Za-z]:[\\/]/.test(value) ? 2 : 0).includes(':') ||
      value.startsWith('\\\\')
    )
      invalid('path_format');
    const resolved = path.resolve(root, value);
    if (!inside(root, resolved)) invalid('outside_workspace');
    let physical;
    try {
      physical = fileSystem.realpathSync.native(resolved);
    } catch (error) {
      if (kind !== 'file' || error.code !== 'ENOENT')
        invalid(error.code === 'ENOENT' ? 'path_missing' : 'path_unavailable');
      try {
        physical = path.join(
          fileSystem.realpathSync.native(path.dirname(resolved)),
          path.basename(resolved)
        );
      } catch {
        invalid('path_unavailable');
      }
    }
    if (!inside(root, physical)) invalid('outside_workspace');
    let stat;
    try {
      if (fileSystem.existsSync(physical)) stat = fileSystem.statSync(physical);
    } catch {
      invalid('path_unavailable');
    }
    if (stat) {
      if ((kind === 'file' && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory()))
        invalid('path_type');
    }
    return physical;
  }
  let cmd,
    workdir = root;
  if (definition.name === 'read_file') {
    const offset = Object.hasOwn(args, 'offset') ? args.offset : 1,
      limit = Object.hasOwn(args, 'limit') ? args.limit : 500;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 1 ||
      offset > 100000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 2000
    )
      invalid('read_range');
    if (
      Object.hasOwn(args, 'tail') &&
      (!Number.isSafeInteger(args.tail) ||
        args.tail < 1 ||
        args.tail > 2000 ||
        Object.hasOwn(args, 'offset') ||
        Object.hasOwn(args, 'limit'))
    )
      invalid('read_tail');
    cmd = clientReadCommand(target(args.file_path, 'file'), {
      offset,
      limit,
      tail: args.tail,
      include_metadata: args.include_metadata,
    });
  } else {
    if (!text(args.pattern, 1024)) invalid('search_pattern');
    const scope = target(
      Object.hasOwn(args, 'path') ? args.path : '.',
      definition.name === 'find_files' ? 'directory' : 'either'
    );
    if (args.include_ignored && (!Object.hasOwn(args, 'path') || inside(scope, root)))
      invalid('ignored_scope');
    if (
      (args.include_hidden || args.include_ignored) &&
      path
        .relative(root, scope)
        .split(/[\\/]/)
        .some(
          (part) =>
            /^(?:node_modules|\.git|\.env(?:\..*)?)$/i.test(part) || /\.(?:pem|key)$/i.test(part)
        )
    )
      invalid('protected_scope');
    cmd = clientSearchCommand(definition.name, args.pattern, scope, args);
    // rg globs are relative to the process cwd, not an absolute search argument.
    if (definition.name === 'find_files') workdir = scope;
  }
  return { cmd, shell: 'powershell.exe', login: false, workdir, max_output_tokens: 2000 };
}

function tianxiClientCommandInput(args) {
  return (
    '// @exec: {"yield_time_ms": 120000}\n' +
    'const deadline = Date.now() + 90000;\n' +
    'let result = await tools.exec_command(' +
    JSON.stringify(args) +
    ');\n' +
    'const parts = [];\n' +
    'let characters = 0, checkedParts = 0, truncated = false;\n' +
    'for (let poll = 0; ; poll++) {\n' +
    'if (result && (result.isError === true || ' +
    '(result.exit_code != null && (!Number.isSafeInteger(result.exit_code) || result.exit_code !== 0)))) ' +
    'throw new Error("Client command failed");\n' +
    'if (result && typeof result === "object" && Number.isFinite(result.original_token_count) && ' +
    'result.original_token_count > 2000) truncated = true;\n' +
    'if (typeof result === "string") parts.push(result);\n' +
    'else if (result && typeof result.output === "string") parts.push(result.output);\n' +
    'else if (result && Array.isArray(result.content) && ' +
    'result.content.every(part => part && part.type === "text" && typeof part.text === "string")) ' +
    'for (const part of result.content) parts.push(part.text);\n' +
    'else throw new Error("Client command returned unsupported output");\n' +
    'for (; checkedParts < parts.length; checkedParts++) characters += parts[checkedParts].length;\n' +
    'if (characters > 20000) throw new Error("Client command output exceeds limit");\n' +
    'if (result && typeof result === "object" && result.session_id != null) {\n' +
    'if (!Number.isSafeInteger(result.session_id) || result.session_id < 0 || poll >= 90 || Date.now() >= deadline) ' +
    'throw new Error("Client command did not complete");\n' +
    'result = await tools.write_stdin({ session_id: result.session_id, chars: "", ' +
    'yield_time_ms: 1000, max_output_tokens: 2000 });\n' +
    '} else {\n' +
    'if (result && typeof result === "object" && result.exit_code === null) ' +
    'throw new Error("Client command did not complete");\n' +
    'break;\n' +
    '}\n' +
    '}\n' +
    'text(parts.join(""));\n' +
    'if (truncated) text("[Output may be truncated by the client token limit. Narrow the scope or line range; missing content is not evidence of absence.]");'
  );
}

module.exports = {
  compileTianxiClientRead,
  tianxiClientReadMetadata,
  tianxiClientCommandInput,
  tianxiClientArgumentFailure,
};
