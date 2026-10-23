'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execFileAsync = promisify(childProcess.execFile);

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
const retryWaitCell = new Int32Array(new SharedArrayBuffer(4));

function renamePrivatePath(fsModule, source, target, platform, waitForRetry) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fsModule.renameSync(source, target);
      return;
    } catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error?.code) || attempt === 2)
        throw error;
      waitForRetry(10 * (attempt + 1));
    }
  }
}

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

function pathCacheKey(kind, resolvedPath, stats) {
  return [
    kind,
    resolvedPath.toLowerCase(),
    stats.dev,
    stats.ino,
    stats.birthtimeNs ?? stats.birthtimeMs,
  ].join(':');
}

function windowsAclArguments(resolvedPath, kind, currentUserSid) {
  const inheritance = kind === 'directory' ? '(OI)(CI)' : '';
  const broadSids = WINDOWS_BROAD_ACCESS_SIDS.map((sid) => `*${sid}`);
  return [
    [resolvedPath, '/reset', '/c', '/q'],
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
  ];
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

  const stats = fsModule.statSync(resolvedPath, { bigint: true });
  const cacheKey = pathCacheKey(kind, resolvedPath, stats);
  if (options.force !== true && securedWindowsPaths.has(cacheKey)) return resolvedPath;
  securedWindowsPaths.delete(cacheKey);

  // Explicit filesystem/process/SID adapters retain their existing backend.
  // Default local paths reuse recovery storage's pinned native ACL operation.
  if (
    fsModule === fs &&
    options.execFileSync === undefined &&
    options.currentUserSid === undefined &&
    (options.environment === undefined || options.environment === process.env) &&
    resolvedPath.length <= 4096 &&
    !/^[\\/]{2}/.test(resolvedPath) &&
    resolvedPath !== path.parse(resolvedPath).root
  ) {
    const { securePrivatePathNative } = require('./private-path-native');
    if (securePrivatePathNative(resolvedPath, kind)) {
      const after = fsModule.statSync(resolvedPath, { bigint: true });
      if (pathCacheKey(kind, resolvedPath, after) !== cacheKey)
        throw Object.assign(new Error('private_path_unavailable'), {
          code: 'private_path_unavailable',
        });
      securedWindowsPaths.add(cacheKey);
      return resolvedPath;
    }
  }

  const markerPath = kind === 'directory' ? path.join(resolvedPath, '.hpm-secured') : null;
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  const environment = options.environment || process.env;
  const currentUserSid = resolveCurrentWindowsUserSid(
    execFileSync,
    environment,
    options.currentUserSid
  );

  if (markerPath && options.force !== true) {
    try {
      if (fsModule.existsSync(markerPath)) {
        const markerSid = String(fsModule.readFileSync(markerPath, 'utf8') || '').trim();
        if (markerSid && markerSid === currentUserSid) {
          securedWindowsPaths.add(cacheKey);
          return resolvedPath;
        }
      }
    } catch (_) {}
  }

  const icaclsPath = resolveWindowsSystemTool('icacls.exe', environment);
  const executionOptions = {
    encoding: 'utf8',
    env: environment,
    windowsHide: true,
  };
  for (const args of windowsAclArguments(resolvedPath, kind, currentUserSid))
    execFileSync(icaclsPath, args, executionOptions);
  if (markerPath) {
    try {
      fsModule.writeFileSync(markerPath, currentUserSid, 'utf8');
    } catch (_) {}
  }
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

function preparePrivateRename(sourcePath, targetPath, options) {
  if (
    typeof targetPath !== 'string' ||
    !targetPath.trim() ||
    targetPath.includes('\0') ||
    targetPath.length > 32767
  )
    throw new TypeError('Private rename target must be a non-empty string');
  const fsModule = options.fsModule || fs;
  const platform = options.platform || process.platform;
  const source = assertExistingPath(sourcePath, 'file', fsModule);
  const target = path.resolve(targetPath);
  const parent = (value) =>
    platform === 'win32' ? path.dirname(value).toLowerCase() : path.dirname(value);
  if (parent(source) !== parent(target))
    throw new Error('Private rename requires the same directory');
  securePrivatePathSync(source, 'file', options);
  const before = fsModule.statSync(source, { bigint: true });
  const sourceKey = pathCacheKey('file', source, before);
  const wasSecured = securedWindowsPaths.has(sourceKey);
  return { fsModule, platform, source, target, before, sourceKey, wasSecured };
}

function finishPrivateRename(prepared, options) {
  const { fsModule, platform, target, before, sourceKey, wasSecured } = prepared;
  securedWindowsPaths.delete(sourceKey);
  const after = fsModule.statSync(target, { bigint: true });
  const preserved =
    typeof before.dev === 'bigint' &&
    typeof before.ino === 'bigint' &&
    before.ino > 0n &&
    typeof before.birthtimeNs === 'bigint' &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.birthtimeNs === after.birthtimeNs;
  if (platform === 'win32' && preserved && wasSecured) {
    securedWindowsPaths.add(pathCacheKey('file', target, after));
    return target;
  }
  return securePrivatePathSync(target, 'file', options);
}

function renamePrivateFileSync(sourcePath, targetPath, options = {}) {
  const waitForRetry = options.waitForRetry || ((ms) => Atomics.wait(retryWaitCell, 0, 0, ms));
  if (typeof waitForRetry !== 'function') throw new TypeError('Invalid private rename retry wait');
  const prepared = preparePrivateRename(sourcePath, targetPath, options);
  renamePrivatePath(
    prepared.fsModule,
    prepared.source,
    prepared.target,
    prepared.platform,
    waitForRetry
  );
  return finishPrivateRename(prepared, options);
}

// Yield while Windows readers close their handles. Synchronous retry sleeps
// cannot release an fs.readFile handle whose close is queued on this event loop.
async function renamePrivateFileAsync(sourcePath, targetPath, options = {}) {
  const waitForRetry =
    options.waitForRetry || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (typeof waitForRetry !== 'function') throw new TypeError('Invalid private rename retry wait');
  const prepared = preparePrivateRename(sourcePath, targetPath, options);
  const { fsModule, source, target, platform } = prepared;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        fsModule.rename(source, target, (error) => (error ? reject(error) : resolve()));
      });
      break;
    } catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error?.code) || attempt === 2)
        throw error;
      await waitForRetry(10 * (attempt + 1));
    }
  }
  return finishPrivateRename(prepared, options);
}

// File logging must not block serving requests while native ACL tools run.
// Keep the same policy and publish cache success only after both commands finish.
async function ensurePrivateFileAsync(filePath, options = {}) {
  const fsModule = options.fsModule || fs;
  const resolvedPath = assertExistingPath(filePath, 'file', fsModule);
  if ((options.platform || process.platform) !== 'win32') {
    fsModule.chmodSync(resolvedPath, PRIVATE_FILE_MODE);
    return resolvedPath;
  }
  const cacheKey = pathCacheKey(
    'file',
    resolvedPath,
    fsModule.statSync(resolvedPath, { bigint: true })
  );
  if (options.force !== true && securedWindowsPaths.has(cacheKey)) return resolvedPath;
  securedWindowsPaths.delete(cacheKey);
  if (
    fsModule === fs &&
    options.execFile === undefined &&
    options.currentUserSid === undefined &&
    (options.environment === undefined || options.environment === process.env) &&
    resolvedPath.length <= 4096 &&
    !/^[\\/]{2}/.test(resolvedPath) &&
    resolvedPath !== path.parse(resolvedPath).root
  ) {
    const { securePrivatePathNativeAsync } = require('./private-path-native');
    if (await securePrivatePathNativeAsync(resolvedPath, 'file')) {
      const after = fsModule.statSync(resolvedPath, { bigint: true });
      if (pathCacheKey('file', resolvedPath, after) !== cacheKey)
        throw Object.assign(new Error('private_path_unavailable'), {
          code: 'private_path_unavailable',
        });
      securedWindowsPaths.add(cacheKey);
      return resolvedPath;
    }
  }
  const environment = options.environment || process.env;
  const execFile = options.execFile || execFileAsync;
  const executionOptions = { encoding: 'utf8', env: environment, windowsHide: true };
  const supplied = String(options.currentUserSid || '').trim();
  let sid = WINDOWS_SID_PATTERN.test(supplied) ? supplied : cachedWindowsUserSid;
  if (!sid) {
    const result = await execFile(
      resolveWindowsSystemTool('whoami.exe', environment),
      ['/user', '/fo', 'csv', '/nh'],
      executionOptions
    );
    const match = String(result?.stdout || '').match(WINDOWS_SID_PATTERN);
    if (!match) throw new Error('Unable to resolve the current Windows user SID');
    sid = match[0].toUpperCase();
    cachedWindowsUserSid = sid;
  }
  for (const args of windowsAclArguments(resolvedPath, 'file', sid))
    await execFile(resolveWindowsSystemTool('icacls.exe', environment), args, executionOptions);
  securedWindowsPaths.add(cacheKey);
  return resolvedPath;
}

module.exports = {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  WINDOWS_ADMINISTRATORS_SID,
  WINDOWS_BROAD_ACCESS_SIDS,
  WINDOWS_SYSTEM_SID,
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
  ensurePrivateFileAsync,
  renamePrivateFileSync,
  renamePrivateFileAsync,
  resolveCurrentWindowsUserSid,
  resolveWindowsSystemTool,
  resetSecurePathCache() {
    securedWindowsPaths.clear();
  },
  securePrivatePathSync,
};
