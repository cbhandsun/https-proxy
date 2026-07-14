const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getClaudeDesktopRoutes,
  getClaudeDesktopTraeProcessStyle,
  isClaudeDesktop3pRequest,
  stripClaudeDesktopPrefix,
  isClaudeDesktopRequest,
  isLocalClaudeDesktopGatewayUrl,
  isAuthorizedClaudeDesktopRequest,
  removeClaudeDesktopGatewayProvider,
  claudeDesktopStatusFromConfig,
} = require('../lib/proxy/claude-desktop');

{
  const routes = getClaudeDesktopRoutes({
    activeProfile: 'yhrouter',
    profiles: [{ id: 'yhrouter' }],
    claudeDesktop: {
      models: [
        {
          routeId: 'gpt-5.5',
          profileId: 'yhrouter',
          upstreamModel: 'gpt-5.5',
          labelOverride: 'GPT-5.5',
          supports1m: true,
        },
        {
          routeId: 'claude-opus-4-8',
          profileId: 'yhrouter',
          upstreamModel: 'gpt-5.4',
          supports1m: false,
        },
        {
          routeId: 'claude-opus-4-6-thinking',
          profileId: 'yhrouter',
          upstreamModel: 'gpt-5.6',
          labelOverride: 'GPT-5.6',
        },
      ],
    },
  });

  assert.deepStrictEqual(
    routes.map((route) => route.from),
    ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-4-6-thinking']
  );
  assert.strictEqual(routes[0].to, 'gpt-5.5');
  assert.strictEqual(routes[0].labelOverride, 'GPT-5.5');
  assert.strictEqual(routes[1].supports1m, false);
  assert.strictEqual(routes[2].to, 'gpt-5.6');
  assert.strictEqual(routes[2].labelOverride, 'GPT-5.6');
}

{
  assert.strictEqual(getClaudeDesktopTraeProcessStyle({ claudeDesktop: {} }), 'thinking');
  assert.strictEqual(
    getClaudeDesktopTraeProcessStyle({ claudeDesktop: {} }, { claudeDesktop3p: true }),
    'text'
  );
  assert.strictEqual(
    getClaudeDesktopTraeProcessStyle({ claudeDesktop: { traeProcessStyle: 'thinking' } }),
    'thinking'
  );
  assert.strictEqual(
    getClaudeDesktopTraeProcessStyle({ claudeDesktop: { traeProcessStyle: 'text' } }),
    'text'
  );
  assert.strictEqual(
    getClaudeDesktopTraeProcessStyle({ claudeDesktop: { traeProcessStyle: 'off' } }),
    ''
  );
  assert.strictEqual(getClaudeDesktopTraeProcessStyle({ claudeDesktop: { mode: 'official' } }), '');
}

{
  assert.strictEqual(
    isClaudeDesktop3pRequest({
      'user-agent': 'claude-cli/2.1.165 (external, claude-desktop-3p, agent-sdk/0.3.165)',
    }),
    true
  );
  assert.strictEqual(
    isClaudeDesktop3pRequest({
      'x-anthropic-billing-header': 'cc_version=2.1.165.7b5; cc_entrypoint=claude-desktop-3p;',
    }),
    true
  );
  assert.strictEqual(
    isClaudeDesktop3pRequest({
      'user-agent': 'claude-cli/2.1.165 (external, agent-sdk/0.3.165)',
      'x-app': 'cli',
    }),
    true
  );
  assert.strictEqual(
    isClaudeDesktop3pRequest({
      'user-agent': 'anthropic-sdk-js/0.94.0',
      'x-app': 'cli',
    }),
    false
  );
}

{
  const routes = getClaudeDesktopRoutes({
    activeProfile: 'yhrouter',
    profiles: [{ id: 'yhrouter' }],
    modelRoutes: [
      { from: 'claude-opus-4-6-thinking', profileId: 'openai-official', to: 'gpt-5.6' },
    ],
    claudeDesktop: {
      models: [
        {
          routeId: 'claude-opus-4-6-thinking',
          labelOverride: 'GPT-5.6 Thinking',
          supports1m: false,
        },
      ],
    },
  });

  assert.deepStrictEqual(routes, [
    {
      from: 'claude-opus-4-6-thinking',
      profileId: 'openai-official',
      to: 'gpt-5.6',
      labelOverride: 'GPT-5.6 Thinking',
      supports1m: false,
    },
  ]);
}

{
  assert.strictEqual(isClaudeDesktopRequest({ protocol: 'claude-desktop' }, '/v1/messages'), true);
  assert.strictEqual(
    isClaudeDesktopRequest({ protocol: 'claude' }, '/claude-desktop/v1/messages'),
    true
  );
  assert.strictEqual(stripClaudeDesktopPrefix('/claude-desktop/v1/models'), '/v1/models');
  assert.strictEqual(isLocalClaudeDesktopGatewayUrl('https://127.0.0.1:3443/claude-desktop'), true);
  assert.strictEqual(
    isLocalClaudeDesktopGatewayUrl('https://localhost:3443/claude-desktop/v1'),
    true
  );
  assert.strictEqual(isLocalClaudeDesktopGatewayUrl('https://api.anthropic.com'), false);
}

{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-claude-desktop-'));
  const oldAppData = process.env.APPDATA;
  try {
    process.env.APPDATA = tmpRoot;
    const claudeDir = path.join(tmpRoot, 'Claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const configPath = path.join(claudeDir, 'claude_desktop_config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        primaryProvider: 'gateway',
        providers: {
          gateway: {
            inferenceGatewayBaseUrl: 'https://127.0.0.1:3443/claude-desktop',
            inferenceGatewayApiKey: 'desktop-current-token',
          },
        },
      }),
      'utf8'
    );
    assert.strictEqual(
      isAuthorizedClaudeDesktopRequest(
        { claudeDesktop: { token: 'proxy-token' } },
        { authorization: 'Bearer desktop-current-token' }
      ),
      true
    );
    assert.strictEqual(
      isAuthorizedClaudeDesktopRequest(
        { claudeDesktop: { token: 'hpm-enc:test' } },
        { authorization: 'Bearer decrypted-token' },
        (value) => (value === 'hpm-enc:test' ? 'decrypted-token' : value)
      ),
      true
    );
    assert.strictEqual(
      isAuthorizedClaudeDesktopRequest(
        { claudeDesktop: { token: 'proxy-token' } },
        { authorization: 'Bearer wrong-token' }
      ),
      false
    );

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        primaryProvider: 'gateway',
        providers: {
          gateway: {
            inferenceGatewayBaseUrl: 'https://api.anthropic.com',
            inferenceGatewayApiKey: 'external-token',
          },
        },
      }),
      'utf8'
    );
    assert.strictEqual(
      isAuthorizedClaudeDesktopRequest(
        { claudeDesktop: { token: 'proxy-token' } },
        { authorization: 'Bearer external-token' }
      ),
      false
    );
  } finally {
    if (oldAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = oldAppData;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

{
  const proxyStatus = claudeDesktopStatusFromConfig(
    {
      primaryProvider: 'gateway',
      providers: {
        gateway: {
          inferenceGatewayBaseUrl: 'https://localhost:3443/claude-desktop',
          inferenceGatewayApiKey: 'hpm-test',
        },
        other: { keep: true },
      },
    },
    true,
    'claude_desktop_config.json'
  );
  assert.strictEqual(proxyStatus.mode, 'proxy');
  assert.strictEqual(proxyStatus.gatewayUrl, 'https://localhost:3443/claude-desktop');
  assert.strictEqual(proxyStatus.hasToken, true);

  const directStatus = claudeDesktopStatusFromConfig(
    {
      primaryProvider: 'gateway',
      providers: {
        gateway: {
          inferenceGatewayBaseUrl: 'https://api.anthropic.com',
        },
      },
    },
    true,
    'claude_desktop_config.json'
  );
  assert.strictEqual(directStatus.mode, 'direct');

  const restored = removeClaudeDesktopGatewayProvider({
    primaryProvider: 'gateway',
    providers: {
      gateway: { inferenceGatewayBaseUrl: 'https://localhost:3443' },
      custom: { keep: true },
    },
  });
  assert.deepStrictEqual(restored, { providers: { custom: { keep: true } } });
  assert.deepStrictEqual(
    removeClaudeDesktopGatewayProvider({ primaryProvider: 'gateway', providers: { gateway: {} } }),
    {}
  );
}

console.log('[claude-desktop.test] ok');
