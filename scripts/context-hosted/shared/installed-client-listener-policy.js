'use strict';

const path = require('node:path');
const { exact } = require('./boundary');
const fail = () => new Error('installed_client_listener_rejected');
function installedListenerPaths(input, runtime = process) {
  const value = exact(input, ['networkRoot', 'ownedNode', 'negativeAddress', 'onBusinessRequest']);
  const temporary = runtime.env.RUNNER_TEMP;
  if (
    runtime.platform !== 'win32' ||
    runtime.env.GITHUB_ACTIONS !== 'true' ||
    runtime.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    runtime.env.RUNNER_OS !== 'Windows' ||
    typeof temporary !== 'string' ||
    !path.isAbsolute(temporary) ||
    path.resolve(temporary) !== temporary
  )
    throw fail();
  const root = path.join(temporary, 'hpm-installed-clients');
  for (const [key, expected] of [
    ['networkRoot', path.join(root, 'n08-hosted-network')],
    ['ownedNode', path.join(root, 'payload/runtime/node/node.exe')],
  ]) {
    if (typeof value[key] !== 'string' || value[key] !== expected || /[\0\r\n]/.test(value[key]))
      throw fail();
  }
  return true;
}
function installedClientRequest(url, servername) {
  return (
    (servername === 'api.openai.com' && ['/v1/responses', '/v1/responses/compact'].includes(url)) ||
    (servername === 'api.anthropic.com' && ['/v1/messages', '/v1/messages?beta=true'].includes(url))
  );
}
module.exports = { installedListenerPaths, installedClientRequest };
