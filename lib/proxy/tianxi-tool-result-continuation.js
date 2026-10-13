'use strict';

const REFERENCE_PATTERN = /^txr_[0-9a-f]{32}$/;

const BRIDGE_NAMESPACE = 'mcp__tianxi_progress';
const BRIDGE_TOOL = 'read_result';
const CALL_PREFIX = 'call_tianxi_result_';
const RESULT_READERS = Object.freeze({
  read_result: '天禧工具执行结果',
  glob_result: '查找文件结果',
  search_result: '内容检索结果',
  list_result: '目录查看结果',
  task_result: '任务管理结果',
  operation_result: '工具操作结果',
});

function tianxiResultReaderName(tool) {
  if (tool === 'Glob') return 'glob_result';
  if (['Grep', 'Search'].includes(tool)) return 'search_result';
  if (['LS', 'List'].includes(tool)) return 'list_result';
  if (['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].includes(tool)) return 'task_result';
  if (['Bash', 'Operation'].includes(tool)) return 'operation_result';
  return BRIDGE_TOOL;
}

function resolveTianxiResultBridge(tools, input, options = {}) {
  if (tools != null && (!Array.isArray(tools) || tools.length > 1024)) return null;
  if (input != null && typeof input !== 'string' && !Array.isArray(input)) return null;
  if (Array.isArray(input) && input.length > 4096) return null;
  const groups = [{ tools: tools || [], loaded: false, source: 'tools' }];
  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (item.type === 'additional_tools' && item.role === 'developer')
      groups.push({ tools: item.tools, loaded: true, source: 'additional_tools' });
    if (
      item.type === 'tool_search_output' &&
      item.status === 'completed' &&
      ['client', 'server'].includes(item.execution)
    )
      groups.push({ tools: item.tools, loaded: true, source: 'tool_search_output' });
  }
  let count = 0;
  let result = null;
  let codeMode = null;
  for (const group of groups) {
    if (!Array.isArray(group.tools) || group.tools.length > 1024) return null;
    for (const tool of group.tools) {
      if (++count > 4096 || !tool || typeof tool !== 'object' || Array.isArray(tool)) return null;
      const candidates = tool.type === 'namespace' ? (tool.tools ?? tool.functions) : [tool];
      if (!Array.isArray(candidates) || candidates.length > 1024) return null;
      for (const candidate of candidates) {
        if (
          ++count > 4096 ||
          !candidate ||
          typeof candidate !== 'object' ||
          Array.isArray(candidate)
        )
          return null;
        const namespace = tool.type === 'namespace' ? tool.name : candidate.namespace;
        if (candidate.defer_loading != null && typeof candidate.defer_loading !== 'boolean')
          continue;
        if (
          candidate.allowed_callers != null &&
          (!Array.isArray(candidate.allowed_callers) ||
            candidate.allowed_callers.length > 2 ||
            candidate.allowed_callers.some(
              (caller) => !['direct', 'programmatic'].includes(caller)
            ) ||
            !candidate.allowed_callers.includes('direct'))
        )
          continue;
        if (
          namespace === 'functions' &&
          candidate.type === 'custom' &&
          candidate.name === 'exec' &&
          typeof candidate.description === 'string' &&
          candidate.description.length <= 65536 &&
          candidate.description.includes('ALL_TOOLS') &&
          candidate.description.includes('tools') &&
          (options.requireCommandExecutor !== true ||
            candidate.description.includes('exec_command')) &&
          (candidate.defer_loading !== true || group.loaded)
        )
          codeMode = {
            namespace: 'functions',
            name: 'exec',
            kind: 'code_mode',
            source: group.source,
          };
        if (candidate.type !== 'function') continue;
        if (candidate.defer_loading === true && !group.loaded) continue;
        if (namespace === BRIDGE_NAMESPACE && candidate.name === BRIDGE_TOOL)
          result = { namespace: BRIDGE_NAMESPACE, name: BRIDGE_TOOL, source: group.source };
        else if (namespace == null && candidate.name === BRIDGE_NAMESPACE + '__' + BRIDGE_TOOL)
          result = { name: candidate.name, source: group.source };
      }
    }
  }
  return options.preferCodeMode === true ? codeMode : result || codeMode;
}

function hasTianxiResultBridge(tools, input) {
  return resolveTianxiResultBridge(tools, input) !== null;
}

function createTianxiResultCall(
  reference,
  binding = { namespace: BRIDGE_NAMESPACE, name: BRIDGE_TOOL },
  nativeTool = 'Read'
) {
  if (typeof reference !== 'string' || !REFERENCE_PATTERN.test(reference)) return null;
  if (
    binding?.kind === 'code_mode' &&
    binding.namespace === 'functions' &&
    binding.name === 'exec'
  ) {
    const readerName = tianxiResultReaderName(nativeTool);
    const preferred =
      readerName === BRIDGE_TOOL
        ? ''
        : `ALL_TOOLS.find(tool => tool.name === ${JSON.stringify('mcp__tianxi_progress__' + readerName)}) || `;
    return {
      id: 'ctc_' + reference,
      type: 'custom_tool_call',
      namespace: 'functions',
      name: 'exec',
      call_id: CALL_PREFIX + reference,
      status: 'completed',
      input:
        'const reader = ' +
        preferred +
        'ALL_TOOLS.find(tool => tool.name === "mcp__tianxi_progress__read_result");\n' +
        'if (!reader) throw new Error("Tianxi result reader is unavailable");\n' +
        `const result = await tools[reader.name]({ reference: ${JSON.stringify(reference)} });\n` +
        'if (result.isError) throw new Error("Tianxi result retrieval failed");\n' +
        'for (const part of result.content || []) if (part.type === "text") text(part.text);',
    };
  }
  if (
    !binding ||
    typeof binding !== 'object' ||
    !(
      (binding.namespace === BRIDGE_NAMESPACE && binding.name === BRIDGE_TOOL) ||
      (binding.namespace == null && binding.name === BRIDGE_NAMESPACE + '__' + BRIDGE_TOOL)
    )
  )
    return null;
  return {
    id: 'fc_' + reference,
    type: 'function_call',
    ...(binding.namespace ? { namespace: binding.namespace } : {}),
    name: binding.name,
    call_id: CALL_PREFIX + reference,
    arguments: JSON.stringify({ reference }),
    status: 'completed',
  };
}

// Inspect only the current turn. An earlier bridge output cannot complete a new user task.
function parseTianxiResultContinuation(input) {
  if (!Array.isArray(input)) return { kind: 'none' };
  if (input.length > 4096) return { kind: 'invalid' };
  let boundary = -1;
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (item?.role === 'user' && (item.type == null || item.type === 'message')) boundary = i;
  }
  const references = new Set();
  let seen = false;
  let unrelatedOutput = false;
  for (let i = boundary + 1; i < input.length; i++) {
    const item = input[i];
    if (!['function_call_output', 'custom_tool_call_output'].includes(item?.type)) continue;
    if (typeof item.call_id !== 'string') {
      unrelatedOutput = true;
      continue;
    }
    if (!item.call_id.startsWith(CALL_PREFIX)) {
      unrelatedOutput = true;
      continue;
    }
    seen = true;
    const reference = item.call_id.slice(CALL_PREFIX.length);
    if (!REFERENCE_PATTERN.test(reference)) return { kind: 'invalid' };
    references.add(reference);
    if (references.size > 128) return { kind: 'invalid' };
  }
  if (seen && unrelatedOutput) return { kind: 'invalid' };
  return seen ? { kind: 'bridge', references: [...references] } : { kind: 'none' };
}

function isTianxiResultCall(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.call_id !== 'string' || !value.call_id.startsWith(CALL_PREFIX)) return false;
  const reference = value.call_id.slice(CALL_PREFIX.length);
  const binding = {
    name: value.name,
    namespace: value.namespace,
    ...(value.type === 'custom_tool_call' ? { kind: 'code_mode' } : {}),
  };
  return ['Read', 'Glob', 'Grep', 'LS', 'TaskList', 'Operation'].some((tool) => {
    const expected = createTianxiResultCall(reference, binding, tool);
    return Boolean(
      expected &&
      Object.keys(value).length === Object.keys(expected).length &&
      Object.keys(expected).every((key) => value[key] === expected[key])
    );
  });
}

module.exports = {
  BRIDGE_NAMESPACE,
  BRIDGE_TOOL,
  RESULT_READERS,
  tianxiResultReaderName,
  REFERENCE_PATTERN,
  createTianxiResultCall,
  hasTianxiResultBridge,
  resolveTianxiResultBridge,
  parseTianxiResultContinuation,
  isTianxiResultCall,
};
