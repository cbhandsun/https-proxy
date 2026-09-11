const assert = require('assert');

const { getLocalServer, getEntryServers } = require('../lib/proxy/config');
const {
  entryLabel,
  modelsFormatForEntry,
  routesForEntry,
  forceClaudeEntry,
  forceChatEntry,
  forceResponsesEntry,
  isPublicLocalManagementPath,
  isPublicEntryHealthPath,
  sendPublicEntryHealth,
  isEntryHealthPath,
  isAllowedEntryPath,
} = require('../lib/proxy/entry-routing');

{
  assert.deepStrictEqual(
    getLocalServer({
      activeProfile: 'legacy',
      profiles: [{ id: 'legacy', listenPort: 4555 }],
    }),
    {
      host: 'localhost',
      listenPort: 4555,
      basePath: '/v1',
    }
  );

  assert.deepStrictEqual(
    getLocalServer({
      localServer: { host: '127.0.0.1', listenPort: 3666, basePath: '/proxy' },
      activeProfile: 'legacy',
      profiles: [{ id: 'legacy', listenPort: 4555 }],
    }),
    {
      host: '127.0.0.1',
      listenPort: 3666,
      basePath: '/proxy',
    }
  );
}

{
  assert.deepStrictEqual(
    getLocalServer({
      localServer: { listenPort: 70000 },
      activeProfile: 'legacy',
      profiles: [{ id: 'legacy', listenPort: '4555' }],
    }),
    {
      host: 'localhost',
      listenPort: 4555,
      basePath: '/v1',
    }
  );

  assert.deepStrictEqual(
    getLocalServer({
      localServer: { listenPort: -1 },
      activeProfile: 'legacy',
      profiles: [{ id: 'legacy', listenPort: 'also-bad' }],
    }),
    {
      host: 'localhost',
      listenPort: 3443,
      basePath: '/v1',
    }
  );

  const entries = getEntryServers({
    localServer: { host: '127.0.0.1', listenPort: 3666, basePath: '/v1' },
    entryServers: [
      { name: 'bad-high', listenPort: 70000, protocol: 'claude' },
      { name: 'bad-negative', listenPort: -3, protocol: 'openai-chat' },
      { name: 'good', listenPort: '4555', protocol: 'responses' },
    ],
  });

  assert.deepStrictEqual(
    entries.map((entry) => entry.name + ':' + entry.listenPort + ':' + entry.protocol),
    ['good:4555:openai-responses']
  );
}

{
  const entries = getEntryServers({
    localServer: { host: '127.0.0.1', listenPort: 3000, basePath: '/v1', protocol: 'claude' },
    entryServers: [
      { listenPort: 3443, protocol: 'claude' },
      { listenPort: 3445, protocol: 'responses' },
      { listenPort: 3447, protocol: 'chat-completions' },
      {
        listenPort: 15721,
        protocol: 'claude-desktop',
        host: '127.0.0.1',
        basePath: '/claude-desktop',
        tls: false,
      },
    ],
  });

  assert.deepStrictEqual(
    entries.map((entry) => entry.listenPort + ':' + entry.protocol),
    [
      '3443:claude',
      '3445:openai-responses',
      '3447:openai-chat',
      '15721:claude-desktop',
      '3080:claude',
      '3082:openai-responses',
      '3084:openai-chat',
    ]
  );
  assert.strictEqual(entries[3].tls, false);
  assert.strictEqual(entries[4].tls, false);
  assert.strictEqual(entries[5].tls, false);
  assert.strictEqual(entries[6].tls, false);
}

{
  const entries = getEntryServers({
    localServer: { host: '127.0.0.1', listenPort: 3000, basePath: '/proxy', protocol: 'responses' },
    entryServers: [{ listenPort: 3443, protocol: 'claude', enabled: false }],
  }).filter((entry) => entry.protocol !== 'claude-desktop');

  assert.deepStrictEqual(entries, [
    {
      name: 'openai-responses',
      host: '127.0.0.1',
      listenPort: 3000,
      basePath: '/proxy',
      protocol: 'openai-responses',
      tls: true,
    },
  ]);
}

{
  const claudeEntry = { protocol: 'claude' };
  const desktopEntry = { protocol: 'claude-desktop' };
  const chatEntry = { protocol: 'openai-chat' };
  const responsesEntry = { protocol: 'openai-responses' };
  const modelRoutes = [{ id: 'model-route' }];
  const claudeDesktopRoutes = [{ id: 'desktop-route' }];

  assert.strictEqual(entryLabel(null), 'claude');
  assert.strictEqual(entryLabel(chatEntry), 'openai-chat');
  assert.strictEqual(modelsFormatForEntry(claudeEntry), 'claude');
  assert.strictEqual(modelsFormatForEntry(chatEntry), 'openai');
  assert.strictEqual(
    routesForEntry(chatEntry, false, { modelRoutes, claudeDesktopRoutes }),
    modelRoutes
  );
  assert.strictEqual(
    routesForEntry(desktopEntry, false, { modelRoutes, claudeDesktopRoutes }),
    claudeDesktopRoutes
  );
  assert.strictEqual(
    routesForEntry(chatEntry, true, { modelRoutes, claudeDesktopRoutes }),
    claudeDesktopRoutes
  );

  assert.strictEqual(forceClaudeEntry(claudeEntry), true);
  assert.strictEqual(forceClaudeEntry(desktopEntry), true);
  assert.strictEqual(forceChatEntry(chatEntry), true);
  assert.strictEqual(forceResponsesEntry(responsesEntry), true);

  assert.strictEqual(isPublicLocalManagementPath('/v1/local/health?x=1'), true);
  assert.strictEqual(isPublicLocalManagementPath('/v1/local/config'), false);
  assert.strictEqual(isPublicEntryHealthPath('GET', '/v1/.well-known/hpm-health?x=1'), true);
  assert.strictEqual(isPublicEntryHealthPath('HEAD', '/v1/.well-known/hpm-health'), true);
  assert.strictEqual(isPublicEntryHealthPath('POST', '/v1/.well-known/hpm-health'), false);
  assert.strictEqual(isEntryHealthPath(claudeEntry, 'GET', '/v1/messages'), true);
  assert.strictEqual(isEntryHealthPath(chatEntry, 'HEAD', '/v1/chat/completions'), true);
  assert.strictEqual(isEntryHealthPath(responsesEntry, 'GET', '/v1/responses'), true);
  assert.strictEqual(isEntryHealthPath(responsesEntry, 'POST', '/v1/responses'), false);
  assert.strictEqual(isAllowedEntryPath(null, 'GET', '/anything'), true);
  assert.strictEqual(isAllowedEntryPath(claudeEntry, 'POST', '/v1/messages/count_tokens'), true);
  assert.strictEqual(isAllowedEntryPath(chatEntry, 'POST', '/v1/chat/completions'), true);
  assert.strictEqual(isAllowedEntryPath(chatEntry, 'POST', '/v1/images/generations'), true);
  assert.strictEqual(isAllowedEntryPath(chatEntry, 'POST', '/images/generations?format=png'), true);
  assert.strictEqual(isAllowedEntryPath(chatEntry, 'POST', '/v1/image-jobs'), true);
  assert.strictEqual(
    isAllowedEntryPath(chatEntry, 'GET', '/v1/image-jobs/imgjob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    true
  );
  assert.strictEqual(
    isAllowedEntryPath(
      chatEntry,
      'DELETE',
      '/v1/image-jobs/imgjob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ),
    true
  );
  assert.strictEqual(isAllowedEntryPath(responsesEntry, 'POST', '/v1/responses'), true);
  assert.strictEqual(isAllowedEntryPath(chatEntry, 'GET', '/v1/models'), true);
  assert.strictEqual(isAllowedEntryPath(chatEntry, 'HEAD', '/v1/models/gpt-5'), true);
  assert.strictEqual(isAllowedEntryPath(chatEntry, 'GET', '/v1/chat/completions'), false);
  assert.strictEqual(isAllowedEntryPath(chatEntry, 'GET', '/v1/images/generations'), false);
  assert.strictEqual(isAllowedEntryPath(chatEntry, 'GET', '/v1/image-jobs'), false);
  assert.strictEqual(isAllowedEntryPath(chatEntry, 'GET', '/v1/image-jobs/bad-id'), false);
  assert.strictEqual(isAllowedEntryPath(chatEntry, 'POST', '/v1/messages'), false);

  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body == null ? '' : String(body);
    },
  };
  sendPublicEntryHealth(response, chatEntry, 'GET');
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.headers['X-HPM-Proxy'], 'https-proxy-manager');
  assert.strictEqual(response.headers['Cache-Control'], 'no-store');
  assert.deepStrictEqual(JSON.parse(response.body), {
    ok: true,
    appId: 'https-proxy-manager',
    ready: true,
    entryProtocol: 'openai-chat',
  });
}

console.log('[entry-servers.test] ok');
