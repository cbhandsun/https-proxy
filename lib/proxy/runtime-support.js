const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { sanitizeLogArgs } = require('./logger');
const { parseBoundedInteger } = require('./management-utils');
const {
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
  ensurePrivateFileAsync,
} = require('./secure-files');

function maskManagementToken(token) {
  const value = String(token || '');
  if (value.length <= 12) return '[redacted]';
  return value.slice(0, 6) + '...' + value.slice(-4);
}

function createRuntimeSupport({
  dataDir,
  initialToken = '',
  logger,
  secureDirectory = ensurePrivateDirectorySync,
  secureFile = ensurePrivateFileSync,
  secureFileAsync = ensurePrivateFileAsync,
} = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new TypeError('createRuntimeSupport requires dataDir');
  }
  let managementToken = String(initialToken || '');
  let fileLoggingSetup;
  let tokenWrite;
  let tokenWritePort;

  function readExistingManagementToken(managementPort) {
    if (managementToken) return managementToken;
    const candidates = [];
    const portNumber = Number(managementPort);
    if (Number.isSafeInteger(portNumber) && portNumber >= 1 && portNumber <= 65535) {
      candidates.push(path.join(dataDir, `.mgmt-token-${portNumber}`));
    }
    candidates.push(path.join(dataDir, '.mgmt-token'));
    for (const tokenFile of candidates) {
      try {
        secureFile(tokenFile);
        const token = fs.readFileSync(tokenFile, 'utf8').trim();
        if (/^[0-9a-f]{32}$/i.test(token)) return token;
      } catch (error) {
        if (error && error.code === 'ENOENT') continue;
        throw error;
      }
    }
    return '';
  }

  function writeManagementTokenFile(managementPort) {
    try {
      managementToken = managementToken || crypto.randomBytes(16).toString('hex');
      secureDirectory(dataDir);
      const tokenFiles = [path.join(dataDir, '.mgmt-token')];
      const portNumber = Number(managementPort);
      if (Number.isSafeInteger(portNumber) && portNumber >= 1 && portNumber <= 65535) {
        tokenFiles.unshift(path.join(dataDir, `.mgmt-token-${portNumber}`));
      }
      for (const tokenFile of tokenFiles) {
        fs.writeFileSync(tokenFile, managementToken, { encoding: 'utf8', mode: 0o600 });
        secureFile(tokenFile);
      }
    } catch (error) {
      logger?.error?.({ err: error }, 'Failed to secure management token file');
      throw error;
    }
    return managementToken;
  }

  function writeManagementTokenFileAsync(managementPort) {
    const portNumber = Number(managementPort);
    const port =
      Number.isSafeInteger(portNumber) && portNumber >= 1 && portNumber <= 65535
        ? portNumber
        : null;
    if (tokenWrite) {
      if (tokenWritePort !== port)
        return Promise.reject(new Error('Management credential write already in progress'));
      return tokenWrite;
    }
    tokenWritePort = port;
    tokenWrite = (async () => {
      try {
        managementToken = managementToken || crypto.randomBytes(16).toString('hex');
        // The containing private directory is established before either file
        // is created. Independent file ACL work may then run concurrently.
        await secureDirectory(dataDir);
        const files = [path.join(dataDir, '.mgmt-token')];
        if (port !== null) files.unshift(path.join(dataDir, `.mgmt-token-${port}`));
        const results = await Promise.allSettled(
          files.map(async (file) => {
            await fs.promises.writeFile(file, managementToken, { encoding: 'utf8', mode: 0o600 });
            await secureFileAsync(file);
          })
        );
        if (results.some((result) => result.status !== 'fulfilled'))
          throw new Error('Management credential persistence unavailable');
        return managementToken;
      } catch {
        logger?.error?.('Failed to secure management token file');
        throw new Error('Management credential persistence unavailable');
      }
    })().finally(() => {
      tokenWrite = undefined;
    });
    return tokenWrite;
  }

  function setupFileConsoleTee() {
    if (process.env.PROXY_DISABLE_FILE_LOG === '1') return Promise.resolve(false);
    if (!fileLoggingSetup)
      fileLoggingSetup = initializeFileConsoleTee().then((ready) => {
        if (!ready) fileLoggingSetup = undefined;
        return ready;
      });
    return fileLoggingSetup;
  }

  async function initializeFileConsoleTee() {
    try {
      secureDirectory(dataDir);
      const maxLogBytes = Math.max(
        256 * 1024,
        parseBoundedInteger(
          process.env.PROXY_LOG_MAX_BYTES,
          5 * 1024 * 1024,
          256 * 1024,
          128 * 1024 * 1024
        )
      );
      const rotateIfOversized = (filePath) => {
        try {
          if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= maxLogBytes) return;
          const rotated = filePath + '.1';
          try {
            fs.unlinkSync(rotated);
          } catch (error) {}
          try {
            fs.renameSync(filePath, rotated);
          } catch (error) {
            fs.writeFileSync(filePath, '', 'utf8');
          }
        } catch (error) {}
      };
      const logPath = path.join(dataDir, 'proxy.log');
      const errPath = path.join(dataDir, 'proxy.err.log');
      rotateIfOversized(logPath);
      rotateIfOversized(errPath);
      for (const filePath of [logPath, errPath]) {
        const fd = fs.openSync(filePath, 'a', 0o600);
        fs.closeSync(fd);
        await secureFileAsync(filePath);
      }
      const out = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });
      const err = fs.createWriteStream(errPath, { flags: 'a', encoding: 'utf8' });
      const originalLog = console.log.bind(console);
      const originalWarn = console.warn.bind(console);
      const originalError = console.error.bind(console);
      const writeLine = (stream, args) => {
        try {
          stream.write(util.format(...sanitizeLogArgs(args)) + '\n');
        } catch (error) {}
      };
      console.log = (...args) => {
        originalLog(...sanitizeLogArgs(args));
        writeLine(out, args);
      };
      console.warn = (...args) => {
        originalWarn(...sanitizeLogArgs(args));
        writeLine(err, args);
      };
      console.error = (...args) => {
        originalError(...sanitizeLogArgs(args));
        writeLine(err, args);
      };
      return true;
    } catch (error) {
      logger?.error?.({ err: error }, 'Failed to initialize file logging');
      return false;
    }
  }

  return {
    readExistingManagementToken,
    setupFileConsoleTee,
    writeManagementTokenFile,
    writeManagementTokenFileAsync,
  };
}

module.exports = {
  createRuntimeSupport,
  maskManagementToken,
};
