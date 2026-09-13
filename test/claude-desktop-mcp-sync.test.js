const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  formatMcpServersForClaudeDesktop,
  mergeMcpServersIntoClaudeDesktop,
  removeManagedMcpServersFromClaudeDesktop,
  inspectClaudeDesktopMcpServers,
  backupClaudeDesktopConfig,
  restoreClaudeDesktopConfigBackup,
} = require('../lib/proxy/claude-desktop');

const { getClientActivityRecords } = require('../lib/proxy/audit');
const { injectPromptPreset } = require('../lib/proxy/handlers/converted-chat-request');

// 1. formatMcpServersForClaudeDesktop
{
  const mcpHub = {
    servers: [
      {
        id: 'local-fs',
        name: 'Local Filesystem',
        url: 'http://localhost:3001',
        enabled: true,
      },
      {
        id: 'search',
        command: 'npx',
        args: ['-y', 'search-server'],
        env: { FOO: 'bar' },
        enabled: true,
      },
      {
        id: 'disabled-srv',
        url: 'http://localhost:3002',
        enabled: false,
      },
      {
        id: 'secure-srv',
        url: 'https://api.example.com/mcp',
        bearerToken: 'hpm-enc:secret-token',
        enabled: true,
      },
    ],
  };

  const formatted = formatMcpServersForClaudeDesktop(mcpHub, (t) =>
    t.replace('hpm-enc:', 'decrypted-')
  );
  assert.strictEqual(Object.keys(formatted).length, 3);
  assert.strictEqual(formatted['local-fs'].url, 'http://localhost:3001');
  assert.strictEqual(formatted['local-fs']._managedBy, 'https-proxy');

  assert.strictEqual(formatted.search.command, 'npx');
  assert.deepStrictEqual(formatted.search.args, ['-y', 'search-server']);
  assert.deepStrictEqual(formatted.search.env, { FOO: 'bar' });
  assert.strictEqual(formatted.search._managedBy, 'https-proxy');

  assert.strictEqual(
    formatted['secure-srv'].headers.Authorization,
    'Bearer decrypted-secret-token'
  );
  assert.strictEqual(formatted['secure-srv']._managedBy, 'https-proxy');
}

// 2. mergeMcpServersIntoClaudeDesktop preserves third-party user MCP servers
{
  const existingContent = {
    primaryProvider: 'gateway',
    mcpServers: {
      'user-custom-server': {
        command: 'uvx',
        args: ['my-tool'],
      },
      'old-managed': {
        url: 'http://localhost:9999',
        _managedBy: 'https-proxy',
      },
    },
  };

  const newServers = {
    'new-managed': {
      url: 'http://localhost:8888',
      _managedBy: 'https-proxy',
    },
  };

  const merged = mergeMcpServersIntoClaudeDesktop(existingContent, newServers);
  assert.deepStrictEqual(merged.mcpServers['user-custom-server'], {
    command: 'uvx',
    args: ['my-tool'],
  });
  assert.strictEqual(merged.mcpServers['old-managed'], undefined); // cleaned up old managed
  assert.strictEqual(merged.mcpServers['new-managed'].url, 'http://localhost:8888');

  const inspected = inspectClaudeDesktopMcpServers(merged);
  assert.strictEqual(inspected.totalCount, 2);
  assert.strictEqual(inspected.managedCount, 1);
  assert.strictEqual(inspected.customCount, 1);
  assert.deepStrictEqual(inspected.managedIds, ['new-managed']);

  // 3. removeManagedMcpServersFromClaudeDesktop only deletes managed ones
  const cleaned = removeManagedMcpServersFromClaudeDesktop(merged);
  assert.strictEqual(cleaned.mcpServers['new-managed'], undefined);
  assert.deepStrictEqual(cleaned.mcpServers['user-custom-server'], {
    command: 'uvx',
    args: ['my-tool'],
  });
}

// 4. backupClaudeDesktopConfig & restoreClaudeDesktopConfigBackup
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-mcp-test-'));
  try {
    const configPath = path.join(tmpDir, 'claude_desktop_config.json');
    fs.writeFileSync(configPath, JSON.stringify({ version: 1 }), 'utf8');

    assert.strictEqual(backupClaudeDesktopConfig(configPath), true);
    assert.strictEqual(fs.existsSync(configPath + '.bak'), true);

    // Overwrite configPath
    fs.writeFileSync(configPath, JSON.stringify({ version: 2 }), 'utf8');
    assert.strictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).version, 2);

    // Restore from backup
    assert.strictEqual(restoreClaudeDesktopConfigBackup(configPath), true);
    assert.strictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).version, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// 5. injectPromptPreset
{
  const chatBody = {
    messages: [{ role: 'user', content: 'hello' }],
  };

  injectPromptPreset(chatBody, {
    id: 'test-preset',
    name: '测试预设',
    content: '始终以中文回复。',
  });
  assert.strictEqual(chatBody.messages.length, 2);
  assert.strictEqual(chatBody.messages[0].role, 'system');
  assert.ok(chatBody.messages[0].content.includes('始终以中文回复。'));

  // Prepending to existing system message
  const chatBodyWithSystem = {
    messages: [
      { role: 'system', content: '原有系统指令' },
      { role: 'user', content: 'hello' },
    ],
  };
  injectPromptPreset(chatBodyWithSystem, { id: 'p2', content: '附加指令' });
  assert.strictEqual(chatBodyWithSystem.messages.length, 2);
  assert.ok(
    chatBodyWithSystem.messages[0].content.startsWith('[预设指令: p2]\n附加指令\n\n原有系统指令')
  );
}

// 6. getClientActivityRecords
{
  const claudeRecords = getClientActivityRecords('claude', 5);
  assert.ok(Array.isArray(claudeRecords));

  const codexRecords = getClientActivityRecords('codex', 5);
  assert.ok(Array.isArray(codexRecords));
}

console.log('[claude-desktop-mcp-sync.test] ok');
