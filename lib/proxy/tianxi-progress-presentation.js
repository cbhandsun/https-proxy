'use strict';

const path = require('node:path');

// A result notification may still describe a running tool. Only settle an
// explicitly terminal status; statusless act_resp remains the legacy result.
function tianxiNativeToolOutcome(action, data) {
  const record = (value) =>
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  action = record(action);
  data = record(data);
  const raw = action.status !== undefined ? action.status : data.status;
  if (raw !== undefined && (typeof raw !== 'string' || raw.length > 64)) return null;
  const status = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (['CANCELED', 'CANCELLED', 'ABORTED'].includes(status)) return 'canceled';
  if (['FAILED', 'ERROR'].includes(status) || action.success === false || data.success === false)
    return 'failed';
  if (['COMPLETED', 'COMPLETE', 'SUCCESS', 'SUCCEEDED', 'DONE'].includes(status)) return 'returned';
  return status === '' ? 'returned' : null;
}

function progressArguments(args) {
  if (typeof args === 'string') {
    if (args.length > 8192) return null;
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  return args && typeof args === 'object' && !Array.isArray(args) ? args : null;
}

function tianxiTaskProgressDetail(name, args) {
  if (!['TaskCreate', 'TaskUpdate'].includes(name)) return null;
  const parsed = progressArguments(args);
  if (!parsed) return null;
  const subject = typeof parsed.subject === 'string' ? parsed.subject.trim() : '';
  const safeSubject =
    subject.length > 0 &&
    subject.length <= 160 &&
    !Array.from(subject).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) &&
    !/[\u2028\u2029\u202a-\u202e\u2066-\u2069<>`[\]{}\\]/.test(subject) &&
    !/(?:bearer|sk[_-]|sat[_-]|password|secret|credential|cookie|token|PRIVATE|[A-Za-z0-9_-]{40,})/i.test(
      subject
    )
      ? subject
      : '';
  const id =
    typeof parsed.taskId === 'string' && /^[0-9]{1,8}$/.test(parsed.taskId) ? parsed.taskId : '';
  const status = ['pending', 'in_progress', 'completed', 'deleted'].includes(parsed.status)
    ? parsed.status
    : '';
  return { subject: safeSubject, taskId: id, status };
}

function tianxiProgressTarget(name, args, workspace) {
  if (!['Read', 'Grep', 'Glob', 'LS', 'List'].includes(name)) return '';
  const parsed = progressArguments(args);
  if (!parsed) return '';
  let target =
    parsed.file_path ?? parsed.filePath ?? parsed.path ?? (name === 'Glob' ? parsed.pattern : null);
  if (typeof target !== 'string' || target.length === 0 || target.length > 1024) return '';
  if (/^[A-Za-z]:[\\/]/.test(target)) {
    if (typeof workspace !== 'string' || !/^[A-Za-z]:[\\/]/.test(workspace)) return '';
    target = path.win32.relative(workspace, target);
  }
  target = target.replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    target.length === 0 ||
    target.length > 160 ||
    !/^[A-Za-z0-9_./*?{},[\]-]+$/.test(target) ||
    target.startsWith('/') ||
    target.split('/').includes('..') ||
    /(?:secret|private|credential|password|cookie|token|auth\.json|\.env|\.npmrc|\.pem|\.key|id_rsa|api[_-]?key|\.git(?:\/|$)|[A-Za-z0-9_-]{40,})/i.test(
      target
    )
  )
    return '';
  return target;
}

const OPERATIONS = Object.freeze({
  read: '\u8bfb\u53d6\u6587\u4ef6',
  grep: '\u68c0\u7d22\u5185\u5bb9',
  glob: '\u67e5\u627e\u6587\u4ef6',
  ls: '\u67e5\u770b\u76ee\u5f55',
  skill: '\u8c03\u7528\u6280\u80fd',
  todowrite: '\u66f4\u65b0\u4efb\u52a1\u5217\u8868',
  taskcreate: '\u521b\u5efa\u4efb\u52a1',
  taskupdate: '\u66f4\u65b0\u4efb\u52a1',
  tasklist: '\u67e5\u770b\u4efb\u52a1\u5217\u8868',
  taskget: '\u67e5\u770b\u4efb\u52a1',
  bash: '\u6267\u884c\u547d\u4ee4',
  write: '\u5199\u5165\u6587\u4ef6',
  edit: '\u7f16\u8f91\u6587\u4ef6',
  multiedit: '\u7f16\u8f91\u6587\u4ef6',
  webfetch: '\u8bfb\u53d6\u7f51\u9875',
  websearch: '\u641c\u7d22\u7f51\u9875',
});

const TIANXI_TASK_STARTED_TEXT = '\u4efb\u52a1\u5df2\u5f00\u59cb\u3002\n';

const RESULT_LABELS = Object.freeze({
  Read: OPERATIONS.read,
  Grep: OPERATIONS.grep,
  Glob: OPERATIONS.glob,
  LS: OPERATIONS.ls,
  List: OPERATIONS.ls,
  Search: OPERATIONS.grep,
  Bash: OPERATIONS.bash,
  TaskCreate: OPERATIONS.taskcreate,
  TaskUpdate: OPERATIONS.taskupdate,
  TaskList: OPERATIONS.tasklist,
  TaskGet: OPERATIONS.taskget,
  Operation: '\u5de5\u5177\u64cd\u4f5c',
});
const TIANXI_RESULT_TOOLS = Object.freeze(Object.keys(RESULT_LABELS));
const LEGACY_RESULT_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'List',
  'Search',
  'Bash',
  'Operation',
]);

function parseTianxiResultFormat(value) {
  return value === undefined ? '1' : value === '1' || value === '2' ? value : null;
}

function tianxiResultToolForFormat(tool, format) {
  if (!TIANXI_RESULT_TOOLS.includes(tool) || !['1', '2'].includes(format)) {
    throw new TypeError('Invalid Tianxi result format');
  }
  return format === '1' && !LEGACY_RESULT_TOOLS.has(tool) ? 'Operation' : tool;
}
const STATUS_LABELS = Object.freeze({
  in_progress: '\u8fdb\u884c\u4e2d',
  completed: '\u5df2\u5b8c\u6210',
  failed: '\u5931\u8d25',
  canceled: '\u5df2\u53d6\u6d88',
  incomplete: '\u672a\u5b8c\u6210',
});

function formatTianxiToolResult(tool, ordinal, status, taskStatus) {
  if (
    typeof tool !== 'string' ||
    !Object.hasOwn(RESULT_LABELS, tool) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 1 ||
    ordinal > 512 ||
    typeof status !== 'string' ||
    !Object.hasOwn(STATUS_LABELS, status) ||
    typeof taskStatus !== 'string' ||
    !Object.hasOwn(STATUS_LABELS, taskStatus)
  )
    throw new TypeError('Invalid Tianxi result display');
  return `${RESULT_LABELS[tool]}\uff08${tool} #${ordinal}\uff09\uff1a${STATUS_LABELS[status]}\u3002\n\u6574\u4f53\u4efb\u52a1\uff08\u8bfb\u53d6\u7ed3\u679c\u65f6\uff09\uff1a${STATUS_LABELS[taskStatus]}\u3002`;
}

function formatTianxiNativeProgress(name, count, phase, options = {}) {
  if (phase === 'returned' && options.showOutcome !== true) return '';
  if (phase === 'awaiting permission')
    return '\u5929\u79a7\u539f\u751f\u5de5\u5177\u6b63\u5728\u7b49\u5f85\u6388\u6743\uff0c\u8bf7\u5728\u5929\u79a7\u5e94\u7528\u4e2d\u67e5\u770b\u6388\u6743\u63d0\u793a\u3002\n';
  if (!['started', 'returned', 'failed', 'canceled'].includes(phase)) return '';
  const candidate = typeof name === 'string' ? name.trim() : '';
  const safeName =
    /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(candidate) &&
    !/^(sat|sk|sess|bearer)[_-]/i.test(candidate)
      ? candidate
      : 'tool';
  const key = safeName.toLowerCase();
  const operation = Object.hasOwn(OPERATIONS, key) ? OPERATIONS[key] : '\u6267\u884c\u5de5\u5177';
  const ordinal = Number.isSafeInteger(count) && count > 0 ? count : 1;
  const outcome =
    phase === 'returned'
      ? '\u5df2\u5b8c\u6210'
      : phase === 'failed'
        ? '\u5931\u8d25'
        : phase === 'canceled'
          ? '\u5df2\u53d6\u6d88'
          : '';
  const target = tianxiProgressTarget(safeName, { path: options.target }, null);
  const task = tianxiTaskProgressDetail(safeName, options.taskDetail);
  if (task && (task.subject || task.taskId || task.status)) {
    const labels = {
      pending: '\u5f85\u5904\u7406',
      in_progress: '\u8fdb\u884c\u4e2d',
      completed: '\u5df2\u5b8c\u6210',
      deleted: '\u5df2\u5220\u9664',
    };
    const detail = [
      task.subject ? `\`${task.subject}\`` : '',
      task.taskId ? `\u4efb\u52a1 ${task.taskId}` : '',
      task.status ? `\u8bf7\u6c42\u8bbe\u4e3a${labels[task.status]}` : '',
    ]
      .filter(Boolean)
      .join('\uff1b');
    return `${operation}${outcome}\uff1a${detail}\uff08${safeName} #${ordinal}\uff09\n`;
  }
  if (target)
    return `${operation}${outcome}\uff1a\`${target}\`\uff08${safeName} #${ordinal}\uff09\n`;
  return `${operation}${outcome}\uff08${safeName} #${ordinal}\uff09\n`;
}

module.exports = {
  tianxiNativeToolOutcome,
  parseTianxiResultFormat,
  tianxiResultToolForFormat,
  TIANXI_RESULT_TOOLS,
  formatTianxiNativeProgress,
  formatTianxiToolResult,
  tianxiProgressTarget,
  tianxiTaskProgressDetail,
  TIANXI_TASK_STARTED_TEXT,
};
