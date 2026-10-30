'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const CLI = 'C:/Program Files/Lenovo/AIAgent/Modules/AgentServer/qodercli.exe';
const CLI_DIGEST = '36f719acc35eeff7c4529b9e68f9e930d1c86c5c752864c5f460478d6217ffc6';
const { endpointFromLog, readEndpoint } = require('./tianxi-qoder-endpoint');
function prepareSdkWorkspace(
  modelId,
  { endpoint = readEndpoint(), readFile = fs.readFileSync } = {}
) {
  if (
    !/^[a-z0-9_-]{1,80}$/.test(modelId) ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(endpoint) ||
    endpoint.length > 55
  )
    throw new Error('tianxi_sdk_endpoint_invalid');
  const binary = readFile(CLI);
  if (!Buffer.isBuffer(binary) || createHash('sha256').update(binary).digest('hex') !== CLI_DIGEST)
    throw new Error('tianxi_sdk_build_changed');
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'hpm-tianxi-sdk-'));
  function cleanup() {
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== parent || !path.basename(absolute).startsWith('hpm-tianxi-sdk-'))
      throw new Error('tianxi_sdk_workspace_invalid');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
  try {
    const authFile = path.join(root, 'host-auth.json'),
      settingsFile = path.join(root, 'settings.json'),
      mcpFile = path.join(root, 'mcp.json');
    fs.writeFileSync(
      authFile,
      JSON.stringify({ type: 'serviceAccount', serviceAccountTokenProvider: 'host' }),
      { mode: 0o600 }
    );
    fs.writeFileSync(settingsFile, JSON.stringify({ vpcInstanceName: endpoint }), { mode: 0o600 });
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        [
          'systemroot',
          'windir',
          'path',
          'pathext',
          'temp',
          'tmp',
          'localappdata',
          'appdata',
          'userprofile',
        ].includes(key.toLowerCase())
      )
    );
    Object.assign(env, {
      QODER_SDK_AUTH_PAYLOAD_FILE: authFile,
      QODER_SDK_AUTH_CONFIG_DIR: root,
      QODER_CONFIG_DIR: root,
      QODER_AGENT_SDK_ENTRYPOINT: 'sdk-ts',
      QODER_AGENT_SDK_VERSION: '1.0.52',
    });
    const common = [
      '--settings',
      settingsFile,
      '--config-dir',
      root,
      '--cwd',
      root,
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      mcpFile,
      '--tools',
      '',
    ];
    return {
      cli: CLI,
      root,
      env,
      args: ['--sdk', ...common],
      workerArgs: [
        '--print',
        '--no-session-persistence',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--model',
        modelId,
        ...common,
        '--max-model-request-retries',
        '0',
      ],
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
module.exports = { prepareSdkWorkspace, endpointFromLog, CLI_DIGEST };
