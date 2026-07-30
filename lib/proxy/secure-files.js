'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const WINDOWS_SYSTEM_SID = 'S-1-5-18';
const WINDOWS_ADMINISTRATORS_SID = 'S-1-5-32-544';
const WINDOWS_BROAD_ACCESS_SIDS = [
  'S-1-1-0',
  'S-1-5-4',
  'S-1-5-11',
  'S-1-5-32-545',
  'S-1-5-32-546',
  'S-1-5-32-547',
];
const WINDOWS_SID_PATTERN = /\bS-\d(?:-\d+){2,}\b/i;
let cachedWindowsUserSid = '';
const securedWindowsPaths = new Set();

function resolveWindowsSystemTool(toolName, environment = process.env) {
  const systemRoot = String(environment.SystemRoot || environment.WINDIR || '').trim();
  if (!systemRoot) return toolName;
  return path.join(systemRoot, 'System32', toolName);
}

function resolveCurrentWindowsUserSid(execFileSync, environment, explicitSid = '') {
  const providedSid = String(explicitSid || '').trim();
  if (WINDOWS_SID_PATTERN.test(providedSid)) return providedSid;
  if (cachedWindowsUserSid) return cachedWindowsUserSid;
  const output = execFileSync(
    resolveWindowsSystemTool('whoami.exe', environment),
    ['/user', '/fo', 'csv', '/nh'],
    {
      encoding: 'utf8',
      env: environment,
      windowsHide: true,
    }
  );
  const match = String(output || '').match(WINDOWS_SID_PATTERN);
  if (!match) throw new Error('Unable to resolve the current Windows user SID');
  cachedWindowsUserSid = match[0].toUpperCase();
  return cachedWindowsUserSid;
}

function assertExistingPath(targetPath, kind, fsModule) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new TypeError('Sensitive path must be a non-empty string');
  }
  if (kind !== 'file' && kind !== 'directory') {
    throw new TypeError('Sensitive path kind must be file or directory');
  }
  const resolvedPath = path.resolve(targetPath);
  const stat = fsModule.statSync(resolvedPath);
  if (kind === 'file' && !stat.isFile()) {
    throw new Error(`Sensitive path is not a file: ${resolvedPath}`);
  }
  if (kind === 'directory' && !stat.isDirectory()) {
    throw new Error(`Sensitive path is not a directory: ${resolvedPath}`);
  }
  return resolvedPath;
}

function securePrivatePathSync(targetPath, kind, options = {}) {
  const fsModule = options.fsModule || fs;
  const platform = options.platform || process.platform;
  const resolvedPath = assertExistingPath(targetPath, kind, fsModule);

  if (platform !== 'win32') {
    fsModule.chmodSync(
      resolvedPath,
      kind === 'directory' ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE
    );
    return resolvedPath;
  }

  const stats = fsModule.statSync(resolvedPath);
  const cacheKey = [kind, resolvedPath.toLowerCase(), stats.dev, stats.ino, stats.birthtimeMs].join(
    ':'
  );
  if (options.force !== true && securedWindowsPaths.has(cacheKey)) return resolvedPath;

  const execFileSync = options.execFileSync || childProcess.execFileSync;
  const environment = options.environment || process.env;
  const currentUserSid = resolveCurrentWindowsUserSid(
    execFileSync,
    environment,
    options.currentUserSid
  );
  const inheritance = kind === 'directory' ? '(OI)(CI)' : '';
  const broadSids = WINDOWS_BROAD_ACCESS_SIDS.map((sid) => `*${sid}`);
  const icaclsPath = resolveWindowsSystemTool('icacls.exe', environment);
  const executionOptions = {
    encoding: 'utf8',
    env: environment,
    windowsHide: true,
  };
  execFileSync(icaclsPath, [resolvedPath, '/reset', '/c', '/q'], executionOptions);
  execFileSync(
    icaclsPath,
    [
      resolvedPath,
      '/inheritance:r',
      '/grant:r',
      `*${currentUserSid}:${inheritance}F`,
      `*${WINDOWS_SYSTEM_SID}:${inheritance}F`,
      `*${WINDOWS_ADMINISTRATORS_SID}:${inheritance}F`,
      '/remove:g',
      ...broadSids,
      '/remove:d',
      ...broadSids,
      '/c',
      '/q',
    ],
    executionOptions
  );
  securedWindowsPaths.add(cacheKey);
  return resolvedPath;
}

function ensurePrivateDirectorySync(directoryPath, options = {}) {
  const fsModule = options.fsModule || fs;
  fsModule.mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  return securePrivatePathSync(directoryPath, 'directory', { ...options, fsModule });
}

function ensurePrivateFileSync(filePath, options = {}) {
  return securePrivatePathSync(filePath, 'file', options);
}

module.exports = {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  WINDOWS_ADMINISTRATORS_SID,
  WINDOWS_BROAD_ACCESS_SIDS,
  WINDOWS_SYSTEM_SID,
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
  resolveCurrentWindowsUserSid,
  resolveWindowsSystemTool,
  resetSecurePathCache() {
    securedWindowsPaths.clear();
  },
  securePrivatePathSync,
};
