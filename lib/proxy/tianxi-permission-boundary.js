'use strict';

const TIANXI_PERMISSION_MESSAGE =
  '天禧请求了额外工具授权，但当前代理没有授权回传通道。本次请求已停止；请改用只读工具，或在天禧应用中执行需要授权的操作。';

function assertTianxiPermissionSupported(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
  if (frame.type !== 'risk_exec') return;
  const error = new Error(TIANXI_PERMISSION_MESSAGE);
  error.code = 'tianxi_native_permission_required';
  error.statusCode = 403;
  throw error;
}

function tianxiReadOnlyInstructions(instructions, enabled) {
  if (!enabled) return instructions;
  const policy =
    'Native execution policy: use only Read, Glob and Grep within the configured workspace. ' +
    'Do not request Bash, Write, Edit, Task, Agent, task-management or interactive tools. ' +
    'There is no interactive approval channel in this session. For project audits, inspect files ' +
    'with the allowed tools and clearly report checks that require unavailable tools as unverified.';
  return typeof instructions === 'string' && instructions.trim()
    ? `${policy}\n\n${instructions}\n\n${policy}`
    : policy;
}

module.exports = {
  assertTianxiPermissionSupported,
  tianxiReadOnlyInstructions,
  TIANXI_PERMISSION_MESSAGE,
};
