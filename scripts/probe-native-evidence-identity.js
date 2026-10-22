'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createNativeLoopbackRpc } = require('./lib/native-loopback-rpc');
const { stopNativeEvidenceChild } = require('./lib/native-evidence-v2-runtime');

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-native-identity-'));
  const env = Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path', 'PATHEXT']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]])
  );
  Object.assign(env, {
    CODEX_HOME: path.join(directory, 'codex'),
    APPDATA: path.join(directory, 'appdata'),
    LOCALAPPDATA: path.join(directory, 'local'),
  });
  for (const key of ['CODEX_HOME', 'APPDATA', 'LOCALAPPDATA']) fs.mkdirSync(env[key]);
  const child = spawn(
    'C:/Users/juhon/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe',
    ['app-server', '--listen', 'stdio://'],
    { cwd: directory, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const rpc = createNativeLoopbackRpc(child);
  const report = {
    schema: 'hpm.context.native-evidence-identity',
    modelCalls: 0,
    oldChatsRead: false,
    installedConfigWritten: false,
    observations: [],
    failureCode: null,
  };
  try {
    await rpc.call('initialize', {
      clientInfo: { name: 'hpm_identity_probe', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    const config = {
      mcp_servers: {
        identity: {
          command: process.execPath,
          args: [path.join(root, 'test/fixtures/native-evidence-identity-mcp.js')],
          startup_timeout_sec: 10,
          enabled_tools: ['probe_identity'],
        },
      },
      hooks: {
        PostToolUse: [
          {
            hooks: [
              {
                type: 'mcp_tool',
                server: 'identity',
                tool: 'capture_hook_only',
                input: {
                  session_id: '${session_id}',
                  hook_event_name: '${hook_event_name}',
                  tool_name: '${tool_name}',
                  tool_use_id: '${tool_use_id}',
                  tool_input: '${tool_input}',
                  tool_response: '${tool_response}',
                },
                timeout: 3,
              },
            ],
          },
        ],
      },
    };
    for (let index = 0; index < 2; index++) {
      const result = await rpc.call('thread/start', { ephemeral: true, cwd: directory, config });
      const threadId = result.thread.id;
      const threadDigest = createHash('sha256').update(threadId).digest('hex');
      await rpc.call('mcpServerStatus/list', { threadId, serverName: 'identity' });
      if (index === 0) {
        const itemDone = rpc.waitFor(
          'item/completed',
          (params) => params?.threadId === threadId && params.item?.type === 'commandExecution'
        );
        await rpc.call('thread/shellCommand', {
          threadId,
          command: 'Write-Output hpm-synthetic-hook-probe',
          timeoutMs: 5000,
        });
        await itemDone;
      }
      for (let repeat = 0; repeat < 2; repeat++) {
        const reply = await rpc.call('mcpServer/tool/call', {
          threadId,
          server: 'identity',
          tool: 'probe_identity',
          arguments: {},
          ...(repeat === 1 ? { _meta: { threadId: 'synthetic-forged-thread' } } : {}),
        });
        report.observations.push({ threadDigest, ...JSON.parse(reply.content[0].text) });
      }
    }
  } catch (problem) {
    report.failureCode = /^native_[a-z_]+$/.test(problem?.code)
      ? problem.code
      : 'identity_probe_failed';
  } finally {
    rpc.close();
    report.processTerminal = await stopNativeEvidenceChild(child);
    // Only the checked, freshly allocated synthetic probe root is removed.
    if (!directory.startsWith(path.join(os.tmpdir(), 'hpm-native-identity-')))
      report.failureCode = 'identity_cleanup_refused';
    else if (report.processTerminal) fs.rmSync(directory, { recursive: true });
  }
  fs.writeFileSync(
    path.join(root, '.hpm-runtime/context-native-evidence-identity-20261012-hooks-result.json'),
    JSON.stringify(report, null, 2),
    { flag: 'wx' }
  );
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.failureCode) process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write('identity_probe_failed\n');
  process.exitCode = 1;
});
