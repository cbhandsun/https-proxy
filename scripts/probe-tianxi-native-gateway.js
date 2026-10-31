'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { nativeProbePermissionArgs } = require('./lib/tianxi-native-probe-config');
const { MODELS } = require('./lib/tianxi-native-gateway-sessions');

async function main() {
  const useDefaults = process.argv[2] === '--defaults';
  const model = useDefaults ? MODELS[0] : process.argv[2] || MODELS[0];
  if (process.argv.length > 3 || !MODELS.includes(model)) throw new Error('model_invalid');
  const installation = path.join(os.homedir(), '.codex', 'tianxi-native');
  const state = JSON.parse(fs.readFileSync(path.join(installation, 'gateway.json'), 'utf8'));
  if (
    !Number.isSafeInteger(state.port) ||
    state.port < 1024 ||
    state.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(state.token)
  )
    throw new Error('state_invalid');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-tianxi-codex-native-'));
  const marker = randomUUID();
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'BEFORE\n');
  fs.writeFileSync(path.join(root, 'marker.txt'), marker);
  const cli = path.join(process.env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin/codex.exe');
  const args = [
    '--no-daemon',
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    ...nativeProbePermissionArgs(root),
    '--json',
    ...(useDefaults
      ? []
      : [
          '-m',
          model,
          '-c',
          'model_provider="tianxi_native"',
          '-c',
          `model_catalog_json=${JSON.stringify(path.join(installation, 'models.json'))}`,
          '-c',
          `model_providers.tianxi_native={name="Tianxi Codex Native Tools",base_url="http://127.0.0.1:${state.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0,http_headers={Authorization="Bearer ${state.token}"}}`,
        ]),
    'Use your actual Codex tools. Do not use agents or external services. Use tools.exec_command to read fixture.txt. Use tools.apply_patch to replace BEFORE with AFTER in fixture.txt. Use tools.exec_command to read fixture.txt and marker.txt and verify the edit. Use functions.exec for these calls. Do not edit other files. Your final answer must be only the exact marker read from marker.txt. Never invent results.',
  ];
  let final = '',
    bytes = 0,
    stderrBytes = 0,
    pending = '',
    deadlineExceeded = false,
    safeError;
  const types = new Set();
  const failureCodes = new Set();
  const started = Date.now();
  const child = spawn(cli, args, {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => {
    if (Number.isSafeInteger(child.pid))
      execFile(
        'taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true },
        () => {}
      );
  };
  const decoder = new StringDecoder('utf8');
  const timer = setTimeout(() => {
    deadlineExceeded = true;
    stop();
  }, 180000);
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 1024 * 1024) stop();
  });
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) return stop();
    pending += decoder.write(chunk);
    for (;;) {
      const index = pending.indexOf('\n');
      if (index < 0) break;
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      try {
        const event = JSON.parse(line);
        if (event.item?.type) types.add(event.item.type);
        if (event.type === 'item.completed' && event.item?.type === 'agent_message')
          final = event.item.text;
        if (event.type === 'error') {
          safeError = 'codex_request_failed';
          for (const code of String(event.message || '').match(/tianxi_[a-z_]{1,80}/g) || [])
            failureCodes.add(code);
        }
      } catch {
        safeError = 'codex_event_invalid';
        stop();
      }
    }
  });
  let exitCode;
  try {
    exitCode = await new Promise((resolve) => {
      child.once('error', () => resolve(-1));
      child.once('close', resolve);
    });
  } finally {
    clearTimeout(timer);
  }
  const edited = fs.readFileSync(path.join(root, 'fixture.txt'), 'utf8').trim() === 'AFTER';
  const passed =
    exitCode === 0 &&
    edited &&
    final.trim() === marker &&
    types.has('command_execution') &&
    types.has('file_change') &&
    !deadlineExceeded;
  process.stdout.write(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        model,
        passed,
        realCodexCli: true,
        realProvider: true,
        persistentGateway: true,
        userConfigurationLoaded: true,
        defaultConfigurationUsed: useDefaults,
        fixtureEdited: edited,
        returnedMarker: final.trim() === marker,
        exitCode,
        itemTypes: [...types],
        deadlineExceeded,
        safeError,
        failureCodes: [...failureCodes],
        elapsedMs: Date.now() - started,
        outputBytes: bytes,
        stderrBytes,
      },
      null,
      2
    ) + '\n'
  );
  for (const name of ['fixture.txt', 'marker.txt']) fs.unlinkSync(path.join(root, name));
  fs.rmdirSync(root);
  if (!passed) process.exitCode = 1;
}
main().catch(() => {
  process.stderr.write('Tianxi persistent gateway probe failed.\n');
  process.exitCode = 1;
});
