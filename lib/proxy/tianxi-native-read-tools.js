'use strict';

const fs = require('node:fs');
const path = require('node:path');

const READ_TOOLS = Object.freeze(['Read', 'Glob', 'Grep']);
const DISALLOWED_TOOLS = Object.freeze([
  'Write',
  'Edit',
  'Bash',
  'Task',
  'Agent',
  'WebSearch',
  'ImageGen',
  'ImageSearch',
]);

class TianxiWorkspaceError extends Error {
  constructor() {
    super('tianxi_native_workspace_invalid');
    this.code = 'tianxi_native_workspace_invalid';
  }
}

function localDirectory(value, fileSystem) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1024 ||
    !/^[A-Za-z]:\\/.test(value) ||
    /[\0\r\n]/.test(value)
  ) {
    throw new TianxiWorkspaceError();
  }
  const resolved = fileSystem.realpathSync.native(value);
  if (!/^[A-Za-z]:\\/.test(resolved) || !fileSystem.statSync(resolved).isDirectory()) {
    throw new TianxiWorkspaceError();
  }
  return path.win32.normalize(resolved);
}

function requestedCodexWorkspace(input) {
  if (!Array.isArray(input)) return null;
  const contexts = [];
  for (const message of input) {
    if (!message || message.role !== 'user') continue;
    const parts = typeof message.content === 'string' ? [message.content] : message.content;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const value = typeof part === 'string' ? part : part?.text;
      if (typeof value !== 'string') continue;
      const matches = [
        ...value.matchAll(/<environment_context>([\s\S]*?)<\/environment_context>/g),
      ];
      if (
        (value.match(/<environment_context>/g) || []).length !== matches.length ||
        (value.match(/<\/environment_context>/g) || []).length !== matches.length
      ) {
        throw new TianxiWorkspaceError();
      }
      for (const match of matches) {
        if (match[1].length > 8192) throw new TianxiWorkspaceError();
        const cwd = [...match[1].matchAll(/<cwd>([^<>]*)<\/cwd>/g)];
        if (cwd.length !== 1) throw new TianxiWorkspaceError();
        contexts.push(cwd[0][1]);
      }
    }
  }
  if (new Set(contexts.map((value) => path.win32.normalize(value).toLowerCase())).size > 1) {
    throw new TianxiWorkspaceError();
  }
  return contexts[0] || null;
}

function isInside(root, candidate) {
  const relative = path.win32.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative))
  );
}

function resolveTianxiNativeReadTools(profile, options = {}) {
  if (!profile || profile.tianxiNativeReadTools !== true) return null;
  try {
    const fileSystem = options.fs || fs;
    const fallback = localDirectory(profile.tianxiWorkspace, fileSystem);
    const root = localDirectory(profile.tianxiWorkspaceRoot || profile.tianxiWorkspace, fileSystem);
    if (!isInside(root, fallback)) {
      throw new TianxiWorkspaceError();
    }
    const requested = requestedCodexWorkspace(options.requestInput);
    const resolved = requested ? localDirectory(requested, fileSystem) : fallback;
    if (!isInside(root, resolved)) throw new TianxiWorkspaceError();
    return {
      cwd: resolved,
      permissionMode: 'default',
      allowedTools: [...READ_TOOLS],
      disallowedTools: [...DISALLOWED_TOOLS],
    };
  } catch (_error) {
    throw new TianxiWorkspaceError();
  }
}

module.exports = { resolveTianxiNativeReadTools, TianxiWorkspaceError };
