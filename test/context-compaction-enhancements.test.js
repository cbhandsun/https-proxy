'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  selectTianxiCompactionWindow,
  buildLocalDeterministicSummary,
  encodeTianxiCompactionSummary,
  decodeTianxiCompactionEnvelope,
  expandTianxiCompactionInput,
  buildCompactionResponsePayload,
} = require('../lib/proxy/tianxi-compaction');
const {
  isConvertedResponsesCompactionEnabled,
  normalizeConvertedResponsesCompactionRequest,
  hasPortableCompactionItems,
  tryHandleConvertedResponsesCompaction,
} = require('../lib/proxy/converted-responses-compaction');
const {
  inferUpstreamContextWindowTokens,
  inferClientAdvertisedWindowTokens,
  scaleTokensForCompactionWatermark,
} = require('../lib/proxy/context-watermark-scaler');
const {
  composeContextProtocolOptions,
  resolveProfileContextProtocolOptions,
  usesNativeContextPlanning,
  preservesContextWindow,
} = require('../lib/proxy/context-recovery-policy');
const { createLocalTokenHandlers } = require('../lib/proxy/local-handlers');
const { validateConfig } = require('../lib/proxy/validator');

function createMockResponse() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(payload = '') {
      this.body += Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
    },
  };
}

test('Tianxi compaction preserves recent completed tool rounds and active user constraints', () => {
  const input = [
    {
      role: 'user',
      content:
        '请帮我重构登录模块，注意不要修改数据库 schema，并且 must keep backward compatibility。',
    },
    {
      type: 'function_call',
      call_id: 'call_old_1',
      name: 'read_file',
      arguments: '{"path":"src/old.js"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call_old_1',
      output: 'old file content '.repeat(30),
    },
    {
      type: 'function_call',
      call_id: 'call_recent_1',
      name: 'read_file',
      arguments: '{"path":"src/auth.js"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call_recent_1',
      output: 'export function login() {}',
    },
    {
      type: 'function_call',
      call_id: 'call_recent_2',
      name: 'edit_file',
      arguments: '{"path":"src/auth.js"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call_recent_2',
      output: 'file updated successfully',
    },
    {
      type: 'compaction_trigger',
    },
  ];

  const windowPlan = selectTianxiCompactionWindow(input, { keepCompletedToolRounds: 2 });
  assert.equal(windowPlan.retainedTailItems.length, 4);
  assert.equal(windowPlan.retainedTailItems[0].call_id, 'call_recent_1');
  assert.equal(windowPlan.retainedTailItems[2].call_id, 'call_recent_2');
  assert.equal(windowPlan.compactableItems.length, 3);

  const summary = buildLocalDeterministicSummary({
    instructions: 'Follow repository style guidelines.',
    input: windowPlan.compactableItems,
  });
  assert.match(summary, /\[Active Constraints & Guardrails\]/);
  assert.match(summary, /不要修改数据库 schema/);
  assert.match(summary, /read_file/);

  const encoded = encodeTianxiCompactionSummary(summary, {
    retainedItems: windowPlan.retainedTailItems,
    model: 'deepseek-chat',
  });
  assert.ok(encoded.startsWith('hpm1:'));

  const decoded = decodeTianxiCompactionEnvelope(encoded);
  assert.equal(decoded.summary, summary);
  assert.equal(decoded.retainedItems.length, 4);

  const nextTurnExpanded = expandTianxiCompactionInput([
    { type: 'compaction', encrypted_content: encoded },
    { role: 'user', content: '现在运行测试确认结果' },
  ]);
  // 1 summary message + 4 retained tool items + 1 new user message = 6 items
  assert.equal(nextTurnExpanded.length, 6);
  assert.equal(nextTurnExpanded[0].role, 'user');
  assert.equal(nextTurnExpanded[1].call_id, 'call_recent_1');
  assert.equal(nextTurnExpanded[4].call_id, 'call_recent_2');
  assert.equal(nextTurnExpanded[5].role, 'user');

  const compactResponse = buildCompactionResponsePayload({
    model: 'deepseek-chat',
    summaryText: summary,
    standalone: true,
    retainedItems: windowPlan.retainedTailItems,
  });
  assert.equal(compactResponse.object, 'response.compaction');
  assert.equal(compactResponse.output[0].type, 'compaction');
});

test('Universal third-party converted Responses compaction handles standalone, inline trigger, and checkpoint expansion', () => {
  const deepseekProfile = {
    id: 'deepseek-v3',
    protocol: 'openai',
    api: 'openai-chat',
    targetUrl: 'https://api.deepseek.com/v1',
    localCompactionEnabled: true,
  };
  const preparedBase = {
    profile: deepseekProfile,
    rewriteTo: 'deepseek-chat',
  };

  assert.equal(isConvertedResponsesCompactionEnabled(preparedBase, {}), true);
  assert.equal(
    isConvertedResponsesCompactionEnabled(
      { profile: { ...deepseekProfile, localCompactionEnabled: false } },
      {}
    ),
    false
  );
  assert.equal(
    isConvertedResponsesCompactionEnabled(
      { profile: { ...deepseekProfile, localCompactionEnabled: undefined } },
      { convertedResponsesCompactionPolicy: 'auto' }
    ),
    true
  );

  // 1. Standalone /v1/responses/compact normalization & execution
  const standaloneBody = {
    model: 'gpt-5',
    instructions: 'Keep answers concise.',
    input: [
      { role: 'user', content: '禁止删除生产环境配置。先检查 config.js' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"config.js"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'module.exports = { env: "prod" };',
      },
    ],
  };
  const originalBuffer = Buffer.from(JSON.stringify(standaloneBody), 'utf8');
  const normalizedPrepared = normalizeConvertedResponsesCompactionRequest(
    { ...preparedBase, buffer: originalBuffer },
    {
      method: 'POST',
      originalBuffer,
      maxBytes: 1024 * 1024,
      protocolOptions: {},
    }
  );
  assert.equal(normalizedPrepared.convertedResponsesStandaloneCompaction, true);

  const standaloneRes = createMockResponse();
  let loggedStatus = null;
  const handledStandalone = tryHandleConvertedResponsesCompaction({
    clientReq: { method: 'POST', headers: {} },
    clientRes: standaloneRes,
    prepared: normalizedPrepared,
    upstreamPath: '/v1/responses/compact',
    startTime: Date.now(),
    protocolOptions: {},
    sendJsonError: (res, code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    },
    logRequestEnd: (_m, _p, _t, status) => {
      loggedStatus = status;
    },
  });
  assert.equal(handledStandalone, true);
  assert.equal(standaloneRes.statusCode, 200);
  assert.equal(loggedStatus, 200);
  const standalonePayload = JSON.parse(standaloneRes.body);
  assert.equal(standalonePayload.object, 'response.compaction');
  const checkpointItem = standalonePayload.output[0];
  assert.equal(checkpointItem.type, 'compaction');
  assert.ok(hasPortableCompactionItems([checkpointItem]));

  // 2. Subsequent turn with hpm1: checkpoint expands in-place (with retained tool items) and deduplicates any call_id already in input
  const followUpBody = {
    model: 'gpt-5',
    input: [
      checkpointItem,
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"config.js"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'module.exports = { env: "prod" };',
      },
      { role: 'user', content: '继续下一步' },
    ],
  };
  const followUpPrepared = {
    ...preparedBase,
    buffer: Buffer.from(JSON.stringify(followUpBody), 'utf8'),
  };
  const followUpReq = { method: 'POST', headers: {} };
  const followUpRes = createMockResponse();
  const interceptedFollowUp = tryHandleConvertedResponsesCompaction({
    clientReq: followUpReq,
    clientRes: followUpRes,
    prepared: followUpPrepared,
    upstreamPath: '/v1/responses',
    startTime: Date.now(),
    protocolOptions: {},
    sendJsonError: () => {},
    logRequestEnd: () => {},
  });
  assert.equal(interceptedFollowUp, false);
  const expandedBody = JSON.parse(followUpPrepared.buffer.toString('utf8'));
  assert.equal(
    expandedBody.input.some((item) => item && item.type === 'compaction'),
    false
  );
  assert.equal(expandedBody.input[0].role, 'user');
  // Ensure call_1 was deduplicated and appears only once as function_call
  const call1Count = expandedBody.input.filter(
    (item) => item && item.type === 'function_call' && item.call_id === 'call_1'
  ).length;
  assert.equal(call1Count, 1);
  assert.equal(expandedBody.input[expandedBody.input.length - 1].content, '继续下一步');
});

test('Adaptive compaction watermark scaling scales token counts for smaller third-party upstreams', () => {
  const deepseekProfile = {
    id: 'deepseek-v3',
    protocol: 'openai',
    api: 'openai-chat',
    targetUrl: 'https://api.deepseek.com/v1',
  };
  const claudeDesktopModel = {
    id: 'claude-sonnet-4-5-20250929',
    supports1m: true,
  };

  assert.equal(inferUpstreamContextWindowTokens('deepseek-chat', deepseekProfile), 128000);
  assert.equal(
    inferClientAdvertisedWindowTokens({
      requestModel: 'claude-sonnet-4-5-20250929',
      claudeDesktopModel,
    }),
    1000000
  );

  const scaled = scaleTokensForCompactionWatermark(60000, {
    requestModel: 'claude-sonnet-4-5-20250929',
    targetModel: 'deepseek-chat',
    profile: deepseekProfile,
    claudeDesktopModel,
  });
  assert.equal(scaled.applied, true);
  assert.ok(scaled.scaledTokens > 60000);
  assert.equal(scaled.rawTokens, 60000);

  // Verify local token handlers return scaled input_tokens and log rawInputTokens
  const { handleCountTokens, handleResponsesInputTokens } = createLocalTokenHandlers({
    estimateTokens: (val) => (val ? 20000 : 0),
    decompressBodyBuffer: (buf) => buf,
  });

  const countRes = createMockResponse();
  let countLogMeta = null;
  handleCountTokens(
    { method: 'POST', headers: {} },
    countRes,
    Buffer.from(
      JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        messages: [{ role: 'user', content: 'hi' }],
      })
    ),
    (_m, _p, _t, _s, meta) => {
      countLogMeta = meta;
    },
    Date.now(),
    {
      targetModel: 'deepseek-chat',
      profile: deepseekProfile,
      claudeDesktopModel,
    }
  );
  const countPayload = JSON.parse(countRes.body);
  assert.ok(countPayload.input_tokens > 20000);
  assert.equal(countLogMeta.rawInputTokens, 20000);
  assert.equal(countLogMeta.watermarkScaled, true);

  // Disabled when profile.adaptiveCompactionWatermark === false
  const disabledRes = createMockResponse();
  handleResponsesInputTokens(
    { method: 'POST', headers: {} },
    disabledRes,
    Buffer.from(JSON.stringify({ model: 'gpt-5', input: 'hello' })),
    () => {},
    Date.now(),
    {
      targetModel: 'deepseek-chat',
      profile: { ...deepseekProfile, adaptiveCompactionWatermark: false },
    }
  );
  const disabledPayload = JSON.parse(disabledRes.body);
  assert.equal(disabledPayload.input_tokens, 20000);
});

test('Per-profile contextPolicy overrides global context planning and passes config validation', async () => {
  const baseGlobalOptions = composeContextProtocolOptions(
    {},
    {
      appSettings: {
        contextPolicyVersion: 2,
        contextPlanningMode: 'native-first',
        contextWindowPreference: 'preserve',
      },
    }
  );
  assert.equal(usesNativeContextPlanning(baseGlobalOptions), true);
  assert.equal(preservesContextWindow(baseGlobalOptions), true);

  // Profile with enhanced policy disables native-only planning and enables auto compaction/watermark
  const enhancedProfileOptions = resolveProfileContextProtocolOptions(baseGlobalOptions, {
    id: 'third-party-glm',
    contextPolicy: 'enhanced',
    maxContextTokens: 96000,
  });
  assert.equal(usesNativeContextPlanning(enhancedProfileOptions), false);
  assert.equal(preservesContextWindow(enhancedProfileOptions), true);
  assert.equal(enhancedProfileOptions.maxContextTokens, 96000);
  assert.equal(enhancedProfileOptions.convertedResponsesCompactionPolicy, 'auto');
  assert.equal(enhancedProfileOptions.compactionWatermarkPolicy, 'adaptive');

  // Profile with legacy policy disables both native planning and window preservation
  const legacyProfileOptions = resolveProfileContextProtocolOptions(baseGlobalOptions, {
    id: 'legacy-chat-upstream',
    contextPolicy: 'legacy',
  });
  assert.equal(usesNativeContextPlanning(legacyProfileOptions), false);
  assert.equal(preservesContextWindow(legacyProfileOptions), false);

  // Profile with native-first policy keeps native-first even if global is legacy
  const legacyGlobalOptions = composeContextProtocolOptions(
    {},
    {
      appSettings: {
        contextPolicyVersion: 1,
        contextPlanningMode: 'legacy',
        contextWindowPreference: 'legacy',
      },
    }
  );
  const nativeProfileOptions = resolveProfileContextProtocolOptions(legacyGlobalOptions, {
    id: 'official-codex',
    contextPolicy: 'native-first',
  });
  assert.equal(usesNativeContextPlanning(nativeProfileOptions), true);
  assert.equal(preservesContextWindow(nativeProfileOptions), true);

  // Validator accepts valid profile/route/protocolOptions settings and rejects invalid ones
  const validResult = validateConfig({
    activeProfile: 'third-party-glm',
    profiles: [
      {
        id: 'third-party-glm',
        name: 'GLM',
        protocol: 'openai',
        api: 'openai-chat',
        targetUrl: 'https://open.bigmodel.cn/api/paas/v4',
        contextPolicy: 'enhanced',
        localCompactionEnabled: true,
        adaptiveCompactionWatermark: true,
        maxContextTokens: 128000,
        clientAdvertisedContextTokens: 200000,
      },
    ],
    modelRoutes: [
      {
        from: 'gpt-5',
        to: 'glm-4.6',
        profileId: 'third-party-glm',
        adaptiveCompactionWatermark: true,
        maxContextTokens: 128000,
        clientContextTokens: 400000,
      },
    ],
    protocolOptions: {
      convertedResponsesCompactionPolicy: 'auto',
      compactionWatermarkPolicy: 'adaptive',
    },
  });
  assert.equal(validResult.valid, true, JSON.stringify(validResult.errors));

  const invalidResult = validateConfig({
    activeProfile: 'bad-profile',
    profiles: [
      {
        id: 'bad-profile',
        name: 'Bad',
        protocol: 'openai',
        targetUrl: 'https://api.example.com/v1',
        contextPolicy: 'unknown-mode',
        maxContextTokens: 512,
      },
    ],
  });
  assert.equal(invalidResult.valid, false);
  assert.ok(invalidResult.errors.some((err) => err.includes('contextPolicy')));
  assert.ok(invalidResult.errors.some((err) => err.includes('maxContextTokens')));

  // Verify Tauri UI profile-save model preserves contextPolicy and compaction fields
  const { buildProfileSaveCandidate } = await import('../tauri-ui/src/app/models/profile-save.js');
  const savedCandidate = buildProfileSaveCandidate(
    {
      profiles: [
        {
          id: 'third-party-glm',
          name: 'GLM Old',
          protocol: 'openai',
          api: 'openai-chat',
          targetUrl: 'https://open.bigmodel.cn/api/paas/v4',
          apiKey: 'sk-test',
          clientAdvertisedContextTokens: 200000,
        },
      ],
    },
    'third-party-glm',
    {
      id: 'third-party-glm',
      name: 'GLM Updated',
      protocol: 'openai',
      targetUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-test',
      contextPolicy: 'enhanced',
      maxContextTokens: 128000,
      localCompactionEnabled: true,
      adaptiveCompactionWatermark: true,
    }
  );
  const savedProfile = savedCandidate.configuration.profiles[0];
  assert.equal(savedProfile.contextPolicy, 'enhanced');
  assert.equal(savedProfile.maxContextTokens, 128000);
  assert.equal(savedProfile.localCompactionEnabled, true);
  assert.equal(savedProfile.adaptiveCompactionWatermark, true);
  assert.equal(savedProfile.clientAdvertisedContextTokens, 200000);
  assert.equal(savedProfile.api, 'openai-chat');
});
