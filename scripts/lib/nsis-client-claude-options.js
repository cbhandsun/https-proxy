'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual, types } = require('node:util');
const { safePath } = require('./nsis-encrypted-contract');
const fail = (code) => new Error(code);

function loopbackUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw fail('claude_case_invalid');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw fail('claude_case_invalid');
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw fail('claude_case_invalid');
  return parsed.href.replace(/\/$/, '');
}

function optionsFor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || types.isProxy(input)) {
    throw fail('claude_case_invalid');
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    throw fail('claude_case_invalid');
  const required = [
    'caseRoot',
    'mode',
    'entryUrl',
    'sourceUrl',
    'model',
    'entryToken',
    'marker',
    'cliPath',
    'nodePath',
    'sourceTool',
    'inspectWitness',
    'spawnOwned',
  ];
  const optional = ['onProgress', 'restartClient'];
  const keys = Reflect.ownKeys(input),
    values = Object.create(null);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => ![...required, ...optional].includes(key))
  )
    throw fail('claude_case_invalid');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw fail('claude_case_invalid');
    values[key] = descriptor.value;
  }
  const options = {
    ...values,
    entryUrl: loopbackUrl(values.entryUrl),
    sourceUrl: loopbackUrl(values.sourceUrl),
  };
  for (const key of ['caseRoot', 'cliPath', 'nodePath', 'sourceTool']) {
    if (
      typeof options[key] !== 'string' ||
      !path.isAbsolute(options[key]) ||
      /[\r\n\0]/.test(options[key])
    ) {
      throw fail('claude_case_invalid');
    }
  }
  if (
    (Object.hasOwn(options, 'restartClient') && options.restartClient !== true) ||
    !['default', 'enhanced'].includes(options.mode) ||
    typeof options.model !== 'string' ||
    !/^[a-zA-Z0-9_.:/-]{1,128}$/.test(options.model) ||
    !/^hpm-synthetic-[a-zA-Z0-9-]{16,128}$/.test(options.entryToken) ||
    !/^HPM_PRIVATE_[a-zA-Z0-9-]{16,128}$/.test(options.marker) ||
    typeof options.spawnOwned !== 'function' ||
    types.isProxy(options.spawnOwned) ||
    typeof options.inspectWitness !== 'function' ||
    types.isProxy(options.inspectWitness) ||
    (options.onProgress !== undefined &&
      (typeof options.onProgress !== 'function' || types.isProxy(options.onProgress)))
  )
    throw fail('claude_case_invalid');
  return options;
}

function createEnvironment(options) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  let root;
  try {
    root = safePath(options.caseRoot, true);
  } catch {
    throw fail('claude_case_invalid');
  }
  if (fs.readdirSync(root).length !== 0) throw fail('claude_case_invalid');
  const home = path.join(root, 'home');
  const temp = path.join(options.caseRoot, 'temp');
  const directories = [
    root,
    home,
    temp,
    path.join(home, 'appdata'),
    path.join(home, 'local'),
    path.join(home, 'claude'),
  ];
  for (const directory of directories.slice(1)) fs.mkdirSync(directory);
  const pin = (directory) => {
    safePath(directory, true);
    const { dev, ino, birthtimeMs } = fs.lstatSync(directory);
    return { dev, ino, birthtimeMs };
  };
  const identities = directories.map(pin);
  const verify = () => {
    try {
      if (!isDeepStrictEqual(directories.map(pin), identities))
        throw fail('claude_case_identity_changed');
    } catch {
      throw fail('claude_case_identity_changed');
    }
  };
  return {
    verify,
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'appdata'),
      LOCALAPPDATA: path.join(home, 'local'),
      CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
      TEMP: temp,
      TMP: temp,
      ANTHROPIC_BASE_URL: options.entryUrl,
      ANTHROPIC_AUTH_TOKEN: options.entryToken,
      ANTHROPIC_MODEL: options.model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    },
  };
}

function isolatedEnvironment(options) {
  try {
    return createEnvironment(options);
  } catch {
    throw fail('claude_case_invalid');
  }
}

function cliArguments(options) {
  const mcp = {
    mcpServers: {
      fixture: {
        command: options.nodePath,
        args: [options.sourceTool],
        env: { HPM_FIXTURE_ENDPOINT: options.sourceUrl },
      },
    },
  };
  return [
    '--bare',
    '-p',
    '--model',
    options.model,
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify(mcp),
    '--allowedTools',
    'mcp__fixture__original',
    '--tools',
    '',
    ...(options.restartClient ? [] : ['--no-session-persistence']),
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--system-prompt',
    'Only call the synthetic original MCP tool when explicitly asked, exactly once. Afterward reply READY. During compaction retain a pointer and never copy the original marker. On a final recovery question use the private evidence directory and reader; do not rerun the original MCP tool.',
  ];
}

module.exports = { loopbackUrl, optionsFor, isolatedEnvironment, cliArguments };
