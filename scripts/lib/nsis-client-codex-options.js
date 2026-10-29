'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { types, isDeepStrictEqual } = require('node:util');
const { safePath } = require('./nsis-encrypted-contract');
const fail = () =>
  Object.assign(new Error('nsis_client_codex_failed'), { code: 'nsis_client_codex_failed' });

function fields(input, required, optional = []) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw fail();
  const keys = Reflect.ownKeys(input),
    result = {};
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => ![...required, ...optional].includes(key))
  )
    throw fail();
  for (const key of keys) {
    const slot = Object.getOwnPropertyDescriptor(input, key);
    if (!slot.enumerable || !Object.hasOwn(slot, 'value')) throw fail();
    result[key] = slot.value;
  }
  return result;
}

function createCodexSyntheticSource(nonce) {
  if (typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) throw fail();
  const marker = 'HPM_SYNTHETIC_' + nonce;
  return Object.freeze({
    text:
      'Synthetic Codex evidence\r\n中文🙂\r\n' +
      nonce.repeat(180) +
      '\r\nREQUIRED_MARKER=' +
      marker,
    marker,
  });
}

function prepareCase(input) {
  const options = fields(
    input,
    ['caseRoot', 'mode', 'entryUrl', 'model', 'entryToken', 'sourceTool', 'spawnOwned'],
    ['onProgress', 'restartClient']
  );
  if (
    (Object.hasOwn(options, 'restartClient') && options.restartClient !== true) ||
    !['default', 'enhanced'].includes(options.mode) ||
    typeof options.model !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.model) ||
    typeof options.entryToken !== 'string' ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(options.entryToken) ||
    typeof options.entryUrl !== 'string' ||
    !/^http:\/\/(127\.0\.0\.1|localhost):[1-9][0-9]{0,4}\/v1\/?$/.test(options.entryUrl) ||
    typeof options.spawnOwned !== 'function' ||
    types.isProxy(options.spawnOwned) ||
    (options.onProgress !== undefined &&
      (typeof options.onProgress !== 'function' || types.isProxy(options.onProgress)))
  )
    throw fail();
  const url = new URL(options.entryUrl);
  if (Number(url.port) < 1024 || Number(url.port) > 65535) throw fail();
  const source = createCodexSyntheticSource(fields(options.sourceTool, ['nonce']).nonce);
  const root = safePath(options.caseRoot, true);
  if (fs.readdirSync(root).length !== 0) throw fail();
  const pin = (directory) => {
    safePath(directory, true);
    const { dev, ino, birthtimeMs } = fs.lstatSync(directory);
    return { dev, ino, birthtimeMs };
  };
  const directories = [root];
  for (const name of ['home', 'appdata', 'localappdata', 'tmp']) {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    directories.push(directory);
  }
  const identities = directories.map(pin);
  const verify = () => {
    if (!isDeepStrictEqual(directories.map(pin), identities)) throw fail();
  };
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT'])
    if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, {
    HOME: directories[1],
    USERPROFILE: directories[1],
    CODEX_HOME: directories[1],
    APPDATA: directories[2],
    LOCALAPPDATA: directories[3],
    TEMP: directories[4],
    TMP: directories[4],
    HPM_NSIS_CLIENT_ENTRY: options.entryToken,
  });
  const configuration = {
    model: options.model,
    model_provider: 'hpm-nsis-synthetic',
    tool_output_token_limit: 40000,
    model_auto_compact_token_limit: 1000000,
    web_search: 'disabled',
    mcp_servers: {},
    'analytics.enabled': false,
    'features.apps': false,
    'model_providers.hpm-nsis-synthetic.name': 'Owned offline NSIS acceptance',
    'model_providers.hpm-nsis-synthetic.base_url': options.entryUrl.replace(/\/$/, ''),
    'model_providers.hpm-nsis-synthetic.env_key': 'HPM_NSIS_CLIENT_ENTRY',
    'model_providers.hpm-nsis-synthetic.wire_api': 'responses',
    'model_providers.hpm-nsis-synthetic.requires_openai_auth': false,
    'model_providers.hpm-nsis-synthetic.supports_websockets': false,
    'model_providers.hpm-nsis-synthetic.request_max_retries': 0,
    'model_providers.hpm-nsis-synthetic.stream_max_retries': 0,
  };
  const args = ['app-server', '--listen', 'stdio://'];
  for (const [key, value] of Object.entries(configuration))
    args.push('-c', key + '=' + JSON.stringify(value));
  return { options, source, root, verify, launch: { args, cwd: root, env } };
}

module.exports = { fields, createCodexSyntheticSource, prepareCase };
