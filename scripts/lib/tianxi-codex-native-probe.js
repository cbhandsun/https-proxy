'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { tianxiSdkRoutes } = require('../../lib/proxy/tianxi-sdk-models');
const { createTianxiNativeProbeServer } = require('./tianxi-native-responses-server');
const { runTianxiSdkMcpExperiment } = require('./tianxi-sdk-mcp-experiment');
const { createTianxiNativeProbeScope } = require('./tianxi-native-probe-scope');
const { nativeProbePermissionArgs } = require('./tianxi-native-probe-config');

function evaluateNativeProbe({
  exitCode,
  edited,
  finalAnswer,
  marker,
  calls,
  rejectedCalls,
  realProvider,
}) {
  const toolExecutionPassed =
    exitCode === 0 &&
    edited === true &&
    typeof finalAnswer === 'string' &&
    typeof marker === 'string' &&
    marker.length > 0 &&
    finalAnswer.trim() === marker &&
    Array.isArray(calls) &&
    calls.includes('apply_patch') &&
    calls.filter((name) => name === 'exec_command').length >= 2 &&
    rejectedCalls === 0;
  return { toolExecutionPassed, passed: toolExecutionPassed && realProvider === true };
}

async function probeTianxiCodexNative(modelId, { run = runTianxiSdkMcpExperiment } = {}) {
  const route = tianxiSdkRoutes().find(
    (r) => r.tianxiSdkModel === modelId && r.exposeInModels !== false
  );
  if (!route) throw new Error('tianxi_codex_probe_model_invalid');
  const cli = path.join(process.env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin/codex.exe');
  const cache = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), '.codex/models_cache.json'), 'utf8')
  );
  const sourceModel = cache.models.find(
    (m) => m.tool_mode === 'code_mode_only' && m.apply_patch_tool_type === 'freeform'
  );
  if (!sourceModel) throw new Error('tianxi_codex_probe_model_metadata_missing');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-tianxi-codex-native-'));
  const fixture = path.join(root, 'fixture.txt'),
    markerFile = path.join(root, 'marker.txt'),
    metadataFile = path.join(root, 'model-catalog.json');
  const marker = randomUUID(),
    token = randomBytes(32).toString('hex');
  fs.writeFileSync(fixture, 'BEFORE\n');
  fs.writeFileSync(markerFile, marker);
  fs.writeFileSync(
    metadataFile,
    JSON.stringify({
      models: [
        {
          ...sourceModel,
          slug: route.from,
          display_name: 'Tianxi isolated native-tools probe',
          context_window: 128000,
          max_context_window: 128000,
          auto_compact_token_limit: 100000,
          experimental_supported_tools: [],
        },
      ],
    })
  );
  const scope = createTianxiNativeProbeScope();
  const callShapes = [],
    outputFlags = [],
    itemTypes = new Set(),
    eventTypes = new Set();
  let finalAnswer = '',
    outputBytes = 0,
    pending = '',
    child,
    stderrBytes = 0,
    effectiveSandbox,
    effectiveApproval,
    turnCompletedMs,
    cliExitedMs,
    deadlineExceeded = false;
  const gateway = createTianxiNativeProbeServer({
    token,
    model: route.from,
    run,
    onOutput(value) {
      scope.observeOutput(value);
      outputFlags.push({
        toolMissing: /not (a function|found)|unknown tool/i.test(value),
        syntaxError: /SyntaxError|unexpected token/i.test(value),
        patchFailed: /patch.*(failed|invalid)|invalid patch|Failed to find expected/i.test(value),
        permissionDenied: /denied|not permitted|outside.*workspace|sandbox/i.test(value),
        outsideProject: /outside (?:of )?(?:the )?(?:project|workspace)|absolute paths/i.test(
          value
        ),
        approvalRejected: /rejected|approval|permission/i.test(value),
        readOnly: /read.only/i.test(value),
        sandboxSetup: /sandbox.*(setup|not configured|failed)|setup.*sandbox/i.test(value),
        empty: !value.trim(),
      });
    },
    onCall(call) {
      scope.accept(call);
      if (call.type !== 'custom_tool_call') return;
      callShapes.push({
        printsResult: /\btext\s*\(/.test(call.input),
        patchObject: /tools\.apply_patch\s*\(\s*\{/.test(call.input),
        patchLiteral: /tools\.apply_patch\s*\(\s*['"`]/.test(call.input),
        relativeFixture: /\*\*\* Update File: fixture\.txt/.test(call.input),
      });
    },
  });
  const started = Date.now();
  try {
    await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${gateway.server.address().port}/v1`;
    const args = [
      '--no-daemon',
      'exec',
      '--ignore-user-config',
      '--ephemeral',
      '--skip-git-repo-check',
      ...nativeProbePermissionArgs(root),
      '--json',
      '-m',
      route.from,
      '-c',
      'model_provider="tianxi_native_probe"',
      '-c',
      `model_catalog_json=${JSON.stringify(metadataFile)}`,
      '--disable',
      'apps',
      '--disable',
      'multi_agent',
      '-c',
      'web_search="disabled"',
      '-c',
      `model_providers.tianxi_native_probe={name="Tianxi isolated native probe",base_url="${base}",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0,http_headers={Authorization="Bearer ${token}"}}`,
      'Use your actual Codex tools, without agents or external services. First use tools.exec_command to read fixture.txt. Then use tools.apply_patch to replace BEFORE with AFTER in fixture.txt. Finally use tools.exec_command to read fixture.txt and marker.txt, and verify the edit. Use functions.exec for these tool calls. Do not edit any other file or inspect model-catalog.json. Your final answer must be only the exact marker read from marker.txt. Never invent the result.',
    ];
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
    child = spawn(cli, args, {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const decoder = new StringDecoder('utf8');
    const stop = () => {
      if (Number.isSafeInteger(child.pid) && child.exitCode === null)
        execFile(
          'taskkill.exe',
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true },
          () => {}
        );
    };
    let timeout;
    const exitCode = await new Promise((resolve) => {
      timeout = setTimeout(() => {
        deadlineExceeded = true;
        stop();
      }, 180000);
      child.stdout.on('data', (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > 4 * 1024 * 1024) {
          stop();
          return;
        }
        pending += decoder.write(chunk);
        for (;;) {
          const i = pending.indexOf('\n');
          if (i < 0) break;
          const line = pending.slice(0, i);
          pending = pending.slice(i + 1);
          try {
            const event = JSON.parse(line);
            eventTypes.add(event.type);
            if (event.type === 'turn.completed') turnCompletedMs = Date.now() - started;
            if (event.item?.type) itemTypes.add(event.item.type);
            if (event.type === 'item.completed' && event.item?.type === 'agent_message')
              finalAnswer = event.item.text;
          } catch {
            stop();
          }
        }
      });
      child.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length;
        const value = chunk.toString('utf8');
        effectiveSandbox ??= value.match(
          /sandbox:\s*(read-only|workspace-write|danger-full-access)/
        )?.[1];
        effectiveApproval ??= value.match(
          /approval:\s*(never|untrusted|on-request|on-failure)/
        )?.[1];
        if (stderrBytes > 1024 * 1024) stop();
      });
      child.once('error', () => resolve(-1));
      child.once('exit', () => {
        cliExitedMs = Date.now() - started;
      });
      child.once('close', resolve);
    });
    clearTimeout(timeout);
    await gateway.close();
    const edited = fs.readFileSync(fixture, 'utf8').trim() === 'AFTER';
    const calls = scope.calls,
      rejectedCalls = scope.rejectedCalls;
    return {
      checkedAt: new Date().toISOString(),
      modelId,
      model: route.from,
      ...evaluateNativeProbe({
        exitCode,
        edited,
        finalAnswer,
        marker,
        calls,
        rejectedCalls,
        realProvider: run === runTianxiSdkMcpExperiment,
      }),
      realCodexCli: true,
      realProvider: run === runTianxiSdkMcpExperiment,
      productionRouteChanged: false,
      codexConfigChanged: false,
      fixtureEdited: edited,
      returnedMarker: finalAnswer.trim() === marker,
      exitCode,
      requests: gateway.requests,
      calls,
      rejectedCalls,
      itemTypes: [...itemTypes],
      eventTypes: [...eventTypes],
      outputShapes: gateway.outputShapes,
      contextShapes: gateway.contextShapes,
      effectiveSandbox,
      effectiveApproval,
      failureCodes: gateway.failureCodes,
      callShapes,
      outputFlags,
      outputBytes,
      stderrBytes,
      elapsedMs: Date.now() - started,
      turnCompletedMs,
      cliExitedMs,
      deadlineExceeded,
    };
  } finally {
    await gateway.close();
    for (const file of [fixture, markerFile, metadataFile]) fs.unlinkSync(file);
    fs.rmdirSync(root);
  }
}

module.exports = { probeTianxiCodexNative, evaluateNativeProbe };
