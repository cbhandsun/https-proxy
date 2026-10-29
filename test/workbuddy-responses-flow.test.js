'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createOpenAIProtocol } = require('../lib/proxy/protocol-openai');
const {
  createOpenAIResponsesToChatHandler,
} = require('../lib/proxy/handlers/responses-to-chat-handler');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const { safeWbipcStatus } = require('../lib/proxy/handlers/workbuddy-responses-flow');
const { TASK_STATE_SCHEMA, TASK_STATE_MARKER } = require('../lib/proxy/context-task-state');
const { createContextCompactionBackoff } = require('../lib/proxy/context-compaction-backoff');
const { createContextSummaryCheckpoints } = require('../lib/proxy/context-summary-checkpoints');
const { createContextArtifactStore } = require('../lib/proxy/context-artifact-store');
for (const value of [null, undefined, 'SECRET', {}, [], NaN, Infinity, 999])
  assert.equal(safeWbipcStatus(value), 'unavailable');
assert.equal(safeWbipcStatus(200), 200);
assert.equal(safeWbipcStatus('E_PAYLOAD_TOO_LARGE'), 'E_PAYLOAD_TOO_LARGE');
const frame = (value) => 'data: ' + JSON.stringify(value) + '\n\n';
const wire = (text = 'ok') =>
  frame({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) +
  frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
  'data: [DONE]\n\n';
function fixture({
  slow = false,
  options = {},
  body = wire(),
  status = 200,
  input = 'ping',
  summaryResponse,
  failureBackoff,
  summaryCheckpoints,
  artifactStore,
} = {}) {
  const protocol = createOpenAIProtocol({
    cleanToolArgs: (_name, args) => args,
    fallbackId: (prefix) => prefix + '_fixture',
    stableCreated: () => 1,
    protocolOptions: options,
  });
  const client = new EventEmitter(),
    req = new EventEmitter(),
    writes = [],
    logs = [],
    errors = [],
    events = [],
    summaryBodies = [],
    headers = {};
  let hostOptions,
    hostBody,
    deliver,
    rejectHost,
    ended = false,
    remembered = 0;
  req.method = 'POST';
  client.writableLength = 0;
  client.accepted = !slow;
  client.setHeader = (name, value) => {
    headers[name] = value;
  };
  client.writeHead = () => {
    client.headersSent = true;
  };
  client.write = (value) => {
    writes.push(String(value));
    if (!client.accepted) client.writableLength += Buffer.byteLength(value);
    return client.accepted;
  };
  client.end = () => {
    ended = true;
    client.writableEnded = true;
    client.emit('finish');
  };
  client.destroy = () => {
    client.destroyed = true;
    client.emit('close');
  };
  const ctx = {
    ...protocol,
    CORS_HEADERS: {},
    contextCompactionFailureBackoff: failureBackoff,
    contextSummaryCheckpoints: summaryCheckpoints,
    contextArtifactStore: artifactStore,
    protocolOptions: { contextWindowPolicy: 'disabled', ...options },
    parseProxyBody: () => ({ model: 'deepseek-v4-flash', input, stream: true }),
    responsesToChatWithHistory: (_client, parsed, model) =>
      protocol.openAIResponsesToChat({ ...parsed, model }),
    rejectUnsupportedResponsesConversion: () => false,
    workBuddyWbipcClient: {
      request(params, signalOptions) {
        const requestBody = JSON.parse(params.body.toString('utf8'));
        if (
          summaryResponse &&
          requestBody.max_tokens === 8192 &&
          requestBody.messages.length === 2
        ) {
          summaryBodies.push(requestBody);
          return Promise.resolve(summaryResponse(requestBody));
        }
        hostBody = requestBody;
        hostOptions = signalOptions;
        return new Promise((resolve, reject) => {
          rejectHost = reject;
          deliver = () =>
            resolve({
              ok: true,
              status,
              headers: {},
              body: typeof body === 'function' ? body(requestBody) : body,
            });
        });
      },
    },
    logRequestEnd: (...args) => logs.push(args),
    logProxyEvent: (...args) => events.push(args),
    createChatToResponsesBridge(sink) {
      const state = {
        id: 'resp_fixture',
        created_at: 1,
        model: 'fixture',
        buffer: '',
        outputIndex: 0,
        text: '',
        pendingToolCalls: [],
        toolCalls: [],
        completedOutputItems: [],
        done: false,
      };
      return {
        responseState: state,
        flush: () => protocol.flushOpenAIChatSseToResponses(sink, state),
      };
    },
    rememberResponsesFromBridge: () => {
      remembered++;
    },
    sendJsonError: (_res, status, payload) => errors.push({ status, payload }),
  };
  const handler = createOpenAIResponsesToChatHandler(ctx, {
    handleConvertedJsonResponse: () => assert.fail('JSON path selected'),
  });
  handler(
    req,
    client,
    {
      authProvider: 'workbuddy',
      profile: { protocol: 'workbuddy' },
      workbuddyAuth: { accessTokenEncrypted: true },
      rewriteTo: '-',
      buffer: Buffer.from('{}'),
    },
    { path: '/v2' },
    '',
    '/v1/responses',
    1
  );
  return {
    client,
    req,
    writes,
    logs,
    errors,
    events,
    summaryBodies,
    headers,
    rejectHost: (error) => rejectHost(error),
    deliver: () => deliver(),
    hostOptions: () => hostOptions,
    hostBody: () => hostBody,
    ended: () => ended,
    remembered: () => remembered,
  };
}
async function main() {
  const toolCall = (id) => ({
    type: 'custom_tool_call',
    call_id: id,
    name: 'exec',
    input: 'synthetic',
  });
  const toolResult = (id, output) => ({ type: 'custom_tool_call_output', call_id: id, output });
  const repairInput = [{ role: 'user', content: 'Synthetic task' }];
  for (let index = 0; index < 12; index += 1)
    repairInput.push(toolCall(`old_${index}`), toolResult(`old_${index}`, 'synthetic'.repeat(150)));
  repairInput.push(
    toolCall('reported'),
    toolResult('reported', 'SECRET_EXECUTION_ERROR'),
    toolResult('reported', JSON.stringify({ exit_code: 0, output: 'SECRET_COMMAND_SUCCESS' }))
  );
  const repaired = fixture({
    input: repairInput,
    options: {
      workbuddyPreflightBodyBytes: 1024,
      workbuddyTargetBodyBytes: 4096,
    },
  });
  await tick();
  const outgoing = repaired.hostBody();
  assert.ok(outgoing, 'repaired history reaches the actual WBIPC send boundary');
  const results = outgoing.messages.filter((message) => message.tool_call_id === 'reported');
  assert.equal(results.length, 1);
  assert.match(results[0].content, /SECRET_EXECUTION_ERROR/);
  assert.match(results[0].content, /SECRET_COMMAND_SUCCESS/);
  assert.ok(
    repaired.events.some(
      ([kind, data]) => kind === 'workbuddy_tool_history_repaired' && data.combinedCalls === 1
    )
  );
  assert.ok(!JSON.stringify([repaired.events, repaired.logs]).includes('SECRET_'));
  repaired.deliver();
  await tick();
  await tick();
  assert.equal(repaired.errors.length, 0);
  assert.equal(repaired.remembered(), 1);
  const progressItem = {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'SECRET_ORIGINAL_PROGRESS' }],
  };
  const interleaved = fixture({
    input: [
      ...repairInput.slice(0, -3),
      toolCall('reported'),
      toolResult('reported', 'SECRET_EXECUTION_ERROR'),
      progressItem,
      toolResult('reported', JSON.stringify({ exit_code: 0, output: 'SECRET_COMMAND_SUCCESS' })),
    ],
    options: {
      workbuddyPreflightBodyBytes: 1024,
      workbuddyTargetBodyBytes: 4096,
    },
  });
  await tick();
  const interleavedBody = interleaved.hostBody();
  assert.ok(interleavedBody, 'interleaved history reaches the mocked native send boundary');
  const interleavedResults = interleavedBody.messages.filter(
    (message) => message.tool_call_id === 'reported'
  );
  assert.equal(interleavedResults.length, 1);
  assert.match(interleavedResults[0].content, /SECRET_EXECUTION_ERROR/);
  assert.match(interleavedResults[0].content, /SECRET_COMMAND_SUCCESS/);
  assert.match(interleavedResults[0].content, /not evidence of event order/);
  assert.ok(
    interleavedBody.messages.some(
      (message) => message.role === 'assistant' && message.content === 'SECRET_ORIGINAL_PROGRESS'
    ),
    'original assistant narration survives conversion and compaction in its original role'
  );
  assert.ok(
    interleaved.events.some(
      ([kind, data]) =>
        kind === 'workbuddy_tool_history_repaired' && data.deferredAssistantMessages === 1
    )
  );
  assert.ok(!JSON.stringify([interleaved.events, interleaved.logs]).includes('SECRET_'));
  interleaved.deliver();
  await tick();
  await tick();
  assert.equal(interleaved.errors.length, 0);
  assert.equal(interleaved.remembered(), 1);
  for (const input of [
    [toolResult('SECRET_ORPHAN', 'SECRET_CONTENT')],
    [toolCall('SECRET_PENDING')],
    [toolCall('SECRET_REUSED'), toolResult('SECRET_REUSED', 'ok'), toolCall('SECRET_REUSED')],
  ]) {
    const invalid = fixture({ input });
    await tick();
    assert.equal(invalid.hostBody(), undefined, 'invalid history never reaches the host');
    assert.equal(invalid.errors[0].status, 400);
    assert.equal(invalid.errors[0].payload.error.code, 'invalid_workbuddy_tool_history');
    assert.equal(invalid.logs.length, 1);
    assert.equal(invalid.logs[0][4].phase, 'converted_history');
    assert.equal(invalid.logs[0][4].usesPreviousResponseId, false);
    assert.equal(invalid.logs[0][4].conversionDiagnostics.sourceScanComplete, true);
    assert.equal(invalid.logs[0][4].conversionDiagnostics.convertedScanComplete, true);
    assert.equal(invalid.remembered(), 0);
    assert.ok(!JSON.stringify([invalid.errors, invalid.events, invalid.logs]).includes('SECRET'));
  }
  const lateBoundary = fixture({
    input: [
      toolCall('SECRET_LATE'),
      toolResult('SECRET_LATE', 'SECRET_FIRST'),
      { role: 'user', content: 'SECRET_NEXT' },
      toolResult('SECRET_LATE', 'SECRET_LATE_OUTPUT'),
    ],
  });
  await tick();
  assert.equal(lateBoundary.hostBody(), undefined);
  const lateLog = lateBoundary.logs[0][4];
  assert.equal(lateLog.historyDiagnostics.orphanRelation, 'closed_call_batch');
  assert.equal(lateLog.historyDiagnostics.boundaryType, 'user');
  assert.equal(lateLog.historyDiagnostics.boundaryMessageIndex, 2);
  assert.equal(lateLog.conversionDiagnostics.sourceMatchingCallCount, 1);
  assert.equal(lateLog.conversionDiagnostics.convertedMatchingCallCount, 1);
  assert.ok(
    !JSON.stringify([lateBoundary.events, lateBoundary.logs, lateBoundary.errors]).includes(
      'SECRET'
    )
  );
  const lateSupplement = fixture({
    input: [
      toolCall('SECRET_OLD'),
      toolResult('SECRET_OLD', 'SECRET_OLD_FIRST'),
      toolCall('SECRET_NEW'),
      toolResult('SECRET_NEW', 'SECRET_NEW_OUTPUT'),
      toolResult('SECRET_OLD', 'SECRET_OLD_LATE'),
    ],
    options: { workbuddyPreflightBodyBytes: 1024, workbuddyTargetBodyBytes: 8192 },
  });
  await tick();
  const lateSend = lateSupplement.hostBody();
  assert.ok(lateSend, 'complete uniquely attributed late evidence reaches the mocked send');
  const lateResults = lateSend.messages.filter((message) => message.tool_call_id === 'SECRET_OLD');
  assert.equal(lateResults.length, 1);
  assert.match(JSON.stringify(lateResults[0].content), /SECRET_OLD_FIRST/);
  assert.match(JSON.stringify(lateResults[0].content), /SECRET_OLD_LATE/);
  assert.match(JSON.stringify(lateResults[0].content), /Do not infer that subsequent calls/);
  assert.ok(
    lateSupplement.events.some(
      ([kind, data]) =>
        kind === 'workbuddy_tool_history_repaired' && data.lateResultsAcrossCallBatches === 1
    )
  );
  assert.ok(
    !JSON.stringify([lateSupplement.events, lateSupplement.logs, lateSupplement.errors]).includes(
      'SECRET'
    )
  );
  lateSupplement.deliver();
  await tick();
  await tick();
  assert.equal(lateSupplement.errors.length, 0);
  assert.equal(lateSupplement.remembered(), 1);
  const requiredOverflow = fixture({
    input: [
      { role: 'system', content: 'SECRET_POLICY'.repeat(100) },
      { role: 'user', content: 'SECRET_ORIGINAL_REQUIREMENT'.repeat(250) },
    ],
    options: { workbuddyPreflightBodyBytes: 1024, workbuddyTargetBodyBytes: 4096 },
  });
  await tick();
  await tick();
  assert.equal(
    requiredOverflow.hostBody(),
    undefined,
    'irreducible request never reaches native transport'
  );
  assert.equal(requiredOverflow.errors.length, 1);
  const overflowError = requiredOverflow.errors[0];
  assert.equal(overflowError.status, 413);
  assert.equal(overflowError.payload.error.code, 'workbuddy_request_too_large');
  assert.equal(overflowError.payload.error.context_reason, 'required_context_too_large');
  assert.match(overflowError.payload.error.message, /current WorkBuddy operational request budget/);
  assert.match(overflowError.payload.error.message, /not a confirmed model context limit/);
  assert.doesNotMatch(overflowError.payload.error.message, /Start a fresh conversation/);
  assert.match(overflowError.payload.error.message, /All original inputs were retained/);
  assert.ok(overflowError.payload.error.required_context_bytes > 4096);
  assert.ok(Number.isSafeInteger(overflowError.payload.error.attempted_body_bytes));
  assert.ok(Number.isSafeInteger(overflowError.payload.error.attempted_input_tokens));
  assert.equal(requiredOverflow.remembered(), 0);
  assert.ok(
    !JSON.stringify([
      requiredOverflow.events,
      requiredOverflow.errors,
      requiredOverflow.logs,
    ]).includes('SECRET')
  );
  const requiredPlanLog = requiredOverflow.events.find(
    ([kind]) => kind === 'workbuddy_context_plan'
  )[1];
  assert.equal(requiredPlanLog.requiredContextMeasured, true);
  assert.equal(requiredPlanLog.taskStateSummaryAttempted, false);
  const archiveInput = [
    { role: 'system', content: 'SECRET_POLICY: preserve authentication and do not replay tools.' },
    { role: 'user', content: 'SECRET_FIRST: repair the proxy.' },
    ...Array.from({ length: 6 }, (_, index) => ({
      role: 'user',
      content: `SECRET_CONSTRAINT_${index}: do not delete. ` + 'Repeated background. '.repeat(1100),
    })),
    { role: 'user', content: 'SECRET_RECENT_1: do not restart.' },
    { role: 'user', content: 'SECRET_RECENT_2: continue.' },
  ];
  const sharedFailureBackoff = createContextCompactionBackoff();
  const failedArchiveOptions = {
    input: archiveInput,
    failureBackoff: sharedFailureBackoff,
    options: { workbuddyPreflightBodyBytes: 1024, workbuddyTargetBodyBytes: 32768 },
    summaryResponse: () => ({
      ok: true,
      status: 200,
      headers: {},
      body: JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: '{"SECRET":"rejected"}' },
          },
        ],
      }),
    }),
  };
  const failedArchive = fixture(failedArchiveOptions);
  for (let index = 0; index < 20 && !failedArchive.errors.length; index++) await tick();
  assert.equal(failedArchive.summaryBodies.length, 1);
  assert.equal(failedArchive.hostBody(), undefined, 'unsafe summary cannot dispatch main request');
  assert.equal(failedArchive.errors.length, 1);
  assert.equal(failedArchive.errors[0].status, 413);
  assert.equal(
    failedArchive.errors[0].payload.error.task_state_failure_reason,
    'summary_schema_invalid'
  );
  assert.match(failedArchive.errors[0].payload.error.message, /compaction failure, not proof/);
  assert.doesNotMatch(failedArchive.errors[0].payload.error.message, /Start a fresh conversation/);
  const failedPlan = failedArchive.events.find(([kind]) => kind === 'workbuddy_context_plan')[1];
  assert.equal(failedPlan.taskStateFailureReason, 'summary_schema_invalid');
  assert.equal(failedPlan.artifactTransactionStatus, 'rolled_back');
  assert.equal(failedPlan.archivedUserMessages, 0);
  assert.equal(failedPlan.compactionTiming.summaryRequests, 1);
  assert.equal(failedPlan.compactionTiming.summaryPendingRequests, 0);
  assert.equal(failedPlan.compactionTiming.summaryChunkMs.length, 1);
  assert.equal(failedPlan.compactionTiming.summaryLastChunk, 1);
  assert.equal(failedPlan.compactionTiming.summaryLastStage, 'validation');
  assert.equal(failedPlan.compactionTiming.summaryLastChunkReused, false);
  const failedOutcome = failedArchive.events.find(
    ([kind]) => kind === 'workbuddy_context_outcome'
  )[1];
  assert.equal(failedOutcome.compactionTiming.summaryLastChunk, 1);
  assert.equal(failedOutcome.compactionTiming.summaryLastStage, 'validation');
  assert.ok(failedPlan.compactionTiming.validationMs >= 0);
  assert.equal(failedArchive.remembered(), 0);
  assert.ok(
    !JSON.stringify([failedArchive.events, failedArchive.errors, failedArchive.logs]).includes(
      'SECRET'
    )
  );
  const failedRetry = fixture(failedArchiveOptions);
  for (let index = 0; index < 20 && !failedRetry.errors.length; index++) await tick();
  assert.equal(
    failedRetry.summaryBodies.length,
    0,
    'fresh random scope must not bypass exact failure cooldown'
  );
  assert.equal(failedRetry.hostBody(), undefined);
  assert.equal(failedRetry.errors[0].status, 413);
  assert.ok(failedRetry.errors[0].payload.error.retry_after_ms > 0);
  assert.match(failedRetry.errors[0].payload.error.message, /temporarily backed off/);
  assert.ok(Number(failedRetry.headers['Retry-After']) > 0);
  assert.ok(Number(failedRetry.headers['Retry-After']) <= 15);
  const retryDiagnostics = failedRetry.events.find(
    ([kind]) => kind === 'workbuddy_context_plan'
  )[1];
  assert.equal(retryDiagnostics.taskStateBackoffApplied, true);
  assert.equal(retryDiagnostics.taskStateSummaryAttempted, false);
  assert.equal(retryDiagnostics.taskStateFailureReason, 'summary_schema_invalid');
  assert.equal(retryDiagnostics.compactionTiming.summaryRequests, 0);
  assert.equal(retryDiagnostics.compactionTiming.summaryLastChunk, undefined);
  assert.equal(retryDiagnostics.archivedUserMessages, 0);
  assert.equal(retryDiagnostics.artifactTransactionStatus, 'rolled_back');
  const changedRetry = fixture({
    ...failedArchiveOptions,
    input: [
      ...archiveInput,
      { role: 'user', content: 'SECRET_NEW_CONSTRAINT: preserve this too.' },
    ],
  });
  for (let index = 0; index < 20 && !changedRetry.errors.length; index++) await tick();
  assert.equal(
    changedRetry.summaryBodies.length,
    1,
    'a new human input cannot inherit an old cooldown'
  );
  assert.ok(
    !JSON.stringify([
      failedRetry.errors,
      failedRetry.events,
      changedRetry.errors,
      changedRetry.events,
    ]).includes('SECRET')
  );
  const archiveCheckpoints = createContextSummaryCheckpoints();
  const archiveArtifacts = createContextArtifactStore();
  const archived = fixture({
    summaryCheckpoints: archiveCheckpoints,
    artifactStore: archiveArtifacts,
    input: archiveInput,
    options: { workbuddyPreflightBodyBytes: 1024, workbuddyTargetBodyBytes: 32768 },
    body(request) {
      if (request.messages.some((message) => message.name === 'hpm_read_context_artifact'))
        return wire();
      const stateMessage = request.messages.find((message) =>
        message.content?.startsWith(TASK_STATE_MARKER)
      );
      const payload = JSON.parse(stateMessage.content.slice(TASK_STATE_MARKER.length + 1));
      const receipt = payload.userArchive.entries[0];
      return (
        frame({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'archive_read',
                    type: 'function',
                    function: {
                      name: 'hpm_read_context_artifact',
                      arguments: JSON.stringify({
                        locator: receipt.locator,
                        scope: receipt.scope,
                        digest: receipt.digest,
                        offsetBytes: 0,
                        limitBytes: 512,
                      }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }) + 'data: [DONE]\n\n'
      );
    },
    summaryResponse(request) {
      assert.equal(request.model, 'deepseek-v4-flash');
      assert.ok(!request.tools && !request.tool_choice);
      const payload = JSON.parse(request.messages[1].content);
      const state = {
        schema: TASK_STATE_SCHEMA,
        version: 1,
        objectives: [],
        requirements: payload.transcript
          .filter((entry) => entry.index >= 2 && entry.index <= 7)
          .map((entry) => ({
            id: `r_${entry.id}`,
            status: 'active',
            sources: [
              {
                citationId: payload.citations.find((citation) => citation.sourceId === entry.id)
                  .citationId,
              },
            ],
          })),
        decisions: [],
        work: [],
        blockers: [],
        nextSteps: [],
        files: [],
      };
      return {
        ok: true,
        status: 200,
        headers: {},
        body: JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: JSON.stringify(state) },
            },
          ],
        }),
      };
    },
  });
  for (
    let tickIndex = 0;
    tickIndex < 20 && !archived.hostBody() && !archived.errors.length;
    tickIndex++
  )
    await tick();
  const archivedBody = archived.hostBody();
  assert.ok(archivedBody, 'authorized user archive reaches the production WBIPC send boundary');
  assert.equal(archived.summaryBodies.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(archivedBody)) <= 32768);
  assert.deepEqual(
    archivedBody.messages.filter((message) => message.role === 'user'),
    [archiveInput[1], ...archiveInput.slice(-2)]
  );
  assert.deepEqual(archivedBody.messages[0], archiveInput[0]);
  assert.ok(archivedBody.tools.some((tool) => tool.function?.name === 'hpm_read_context_artifact'));
  const archiveState = archivedBody.messages.find((message) =>
    message.content?.startsWith(TASK_STATE_MARKER)
  );
  const archivePayload = JSON.parse(archiveState.content.slice(TASK_STATE_MARKER.length + 1));
  assert.equal(archivePayload.userArchive.entries.length, 6);
  assert.equal(archivePayload.userArchive.replayExternalTools, false);
  archived.deliver();
  for (
    let tickIndex = 0;
    tickIndex < 20 && archived.hostBody() === archivedBody && !archived.errors.length;
    tickIndex++
  )
    await tick();
  const recoveryBody = archived.hostBody();
  assert.notEqual(
    recoveryBody,
    archivedBody,
    'archive page reaches the production continuation boundary'
  );
  const restored = recoveryBody.messages.find(
    (message) => message.name === 'hpm_read_context_artifact'
  );
  assert.ok(restored);
  const restoredPage = JSON.parse(restored.content);
  assert.equal(restoredPage.ok, true);
  assert.equal(restoredPage.page.text, JSON.stringify(archiveInput[2]).slice(0, 512));
  assert.ok(restoredPage.page.nextOffsetBytes > 0);
  assert.equal(
    archived.summaryBodies.length,
    1,
    'readback does not resummarize or execute an external tool'
  );
  archived.deliver();
  await tick();
  await tick();
  assert.equal(archived.errors.length, 0);
  assert.equal(archived.remembered(), 1);
  const archivePlan = archived.events.find(([kind]) => kind === 'workbuddy_context_plan')[1];
  assert.equal(archivePlan.userArchiveStatus, 'committed');
  assert.equal(archivePlan.archivedUserMessages, 6);
  assert.equal(archivePlan.taskStateCheckpointCommitted, true);
  assert.ok(!JSON.stringify([archived.events, archived.errors, archived.logs]).includes('SECRET'));
  const archivedReconnect = fixture({
    input: archiveInput,
    options: { workbuddyPreflightBodyBytes: 1024, workbuddyTargetBodyBytes: 32768 },
    summaryCheckpoints: archiveCheckpoints,
    artifactStore: archiveArtifacts,
    summaryResponse() {
      throw new Error('An exact checkpoint reconnect must not request a model');
    },
  });
  for (
    let index = 0;
    index < 20 && !archivedReconnect.hostBody() && !archivedReconnect.errors.length;
    index++
  )
    await tick();
  assert.equal(archivedReconnect.errors.length, 0);
  assert.equal(archivedReconnect.summaryBodies.length, 0);
  const reconnectState = archivedReconnect
    .hostBody()
    .messages.find((message) => message.content?.startsWith(TASK_STATE_MARKER));
  const reconnectPayload = JSON.parse(reconnectState.content.slice(TASK_STATE_MARKER.length + 1));
  assert.equal(reconnectPayload.userArchive.entries.length, 6);
  assert.notEqual(
    reconnectPayload.userArchive.entries[0].scope,
    archivePayload.userArchive.entries[0].scope
  );
  assert.notEqual(
    reconnectPayload.userArchive.entries[0].locator,
    archivePayload.userArchive.entries[0].locator
  );
  const firstReceipt = archivePayload.userArchive.entries[0];
  const reconnectReceipt = reconnectPayload.userArchive.entries[0];
  assert.deepEqual(
    archiveArtifacts.read(
      'workbuddy',
      reconnectReceipt.scope,
      reconnectReceipt.locator,
      reconnectReceipt.digest
    ).value,
    archiveInput[2]
  );
  assert.equal(
    archiveArtifacts.read(
      'workbuddy',
      reconnectReceipt.scope,
      firstReceipt.locator,
      firstReceipt.digest
    ).ok,
    false,
    'a semantic hit cannot transfer a previous evidence scope'
  );
  assert.equal(
    archiveArtifacts.read(
      'foreign-owner',
      reconnectReceipt.scope,
      reconnectReceipt.locator,
      reconnectReceipt.digest
    ).ok,
    false
  );
  archivedReconnect.deliver();
  await tick();
  await tick();
  const reconnectOutcome = archivedReconnect.events.find(
    ([kind]) => kind === 'workbuddy_context_outcome'
  )[1];
  assert.equal(reconnectOutcome.taskStateCheckpointHits, 1);
  assert.equal(reconnectOutcome.taskStateFrontierReused, true);
  assert.equal(reconnectOutcome.taskStateFrontierSourceMessages, archiveInput.length);
  assert.equal(reconnectOutcome.compactionTiming.summaryRequests, 0);
  assert.equal(reconnectOutcome.taskStateSummaryAttempted, false);
  assert.ok(
    !JSON.stringify([
      archivedReconnect.events,
      archivedReconnect.errors,
      archivedReconnect.logs,
    ]).includes('SECRET')
  );
  archiveCheckpoints.close();
  archiveArtifacts.close();
  const rejection = fixture();
  await tick();
  const unsafe = new Error('SECRET');
  unsafe.code = 'SECRET';
  rejection.rejectHost(unsafe);
  await tick();
  assert.ok(
    !JSON.stringify([rejection.events, rejection.errors, rejection.logs]).includes('SECRET')
  );
  const early = fixture();
  early.req.emit('aborted');
  await tick();
  assert.equal(early.hostOptions(), undefined);
  assert.equal(early.logs.length, 1);
  assert.equal(early.logs[0][3], 499);
  const cancel = fixture();
  await tick();
  assert.ok(cancel.hostOptions()?.signal, 'WBIPC must receive cancellation signal');
  cancel.client.emit('close');
  assert.equal(cancel.hostOptions().signal.aborted, true);
  cancel.deliver();
  await tick();
  assert.equal(cancel.writes.length, 0);
  assert.equal(cancel.errors.length, 0);
  assert.equal(cancel.logs.length, 1);
  assert.equal(cancel.logs[0][3], 499);
  assert.equal(cancel.client.listenerCount('close'), 0);
  assert.equal(cancel.req.listenerCount('aborted'), 0);
  const requestAbort = fixture();
  await tick();
  requestAbort.req.emit('aborted');
  requestAbort.deliver();
  await tick();
  assert.equal(requestAbort.hostOptions().signal.aborted, true);
  assert.equal(requestAbort.logs.length, 1);
  assert.equal(requestAbort.errors.length, 0);
  const downstreamError = fixture();
  await tick();
  downstreamError.client.emit('error', new Error('SECRET'));
  downstreamError.deliver();
  await tick();
  assert.equal(downstreamError.logs[0][3], 502);
  assert.ok(!JSON.stringify(downstreamError.logs).includes('SECRET'));
  const slow = fixture({ slow: true });
  await tick();
  slow.deliver();
  await tick();
  await tick();
  assert.equal(slow.ended(), false, 'must wait for drain');
  assert.equal(slow.logs.length, 0, 'success must wait for finish');
  assert.equal(
    slow.events.filter((event) => event[0] === 'workbuddy_context_outcome').length,
    0,
    'context success must also wait for finish'
  );
  assert.equal(slow.writes.length, 1);
  slow.client.accepted = true;
  slow.client.writableLength = 0;
  slow.client.emit('drain');
  await tick();
  assert.equal(slow.ended(), true);
  assert.equal(slow.logs.length, 1);
  assert.equal(slow.logs[0][3], 200);
  assert.equal(slow.remembered(), 1);
  assert.equal(slow.hostOptions().signal.aborted, false);
  assert.equal(slow.client.listenerCount('drain'), 0);
  assert.equal(slow.client.listenerCount('close'), 0);
  assert.ok(slow.writes.join('').includes('event: response.completed'));
  const overflow = fixture({ options: { maxConversionOutputBufferBytes: 64 } });
  await tick();
  overflow.deliver();
  await tick();
  await tick();
  assert.equal(overflow.client.destroyed, true);
  assert.equal(overflow.logs.length, 1);
  assert.equal(overflow.logs[0][3], 502);
  assert.equal(overflow.remembered(), 0);
  const pending = fixture({ slow: true });
  await tick();
  pending.deliver();
  await tick();
  pending.client.emit('close');
  await tick();
  assert.equal(pending.logs.length, 1);
  assert.equal(pending.logs[0][3], 499);
  assert.equal(pending.ended(), false);
  const unicode = fixture({ body: wire('中文 😀'.repeat(5000)) });
  await tick();
  unicode.deliver();
  await tick();
  await tick();
  assert.equal(unicode.logs[0][3], 200);
  assert.ok(unicode.writes.join('').includes('中文 😀'));
  assert.ok(!unicode.writes.join('').includes('�'));
  const malformed = fixture({ body: 'data: SECRET\n\n' });
  await tick();
  malformed.deliver();
  await tick();
  assert.equal(malformed.errors[0].status, 502);
  assert.ok(!JSON.stringify(malformed.errors).includes('SECRET'));
  for (const body of [null, {}, 1, 'x'.repeat(1024 * 1024 + 1)]) {
    const invalid = fixture({ body });
    await tick();
    invalid.deliver();
    await tick();
    assert.equal(invalid.errors[0].status, 502);
    assert.equal(invalid.writes.length, 0);
    assert.equal(invalid.remembered(), 0);
  }
  for (const status of [199, 600, NaN, 'SECRET']) {
    const invalid = fixture({ status });
    await tick();
    invalid.deliver();
    await tick();
    assert.equal(invalid.errors[0].status, 502);
    assert.ok(!JSON.stringify(invalid.errors).includes('SECRET'));
  }
  const empty = fixture({ body: '' });
  await tick();
  empty.deliver();
  await tick();
  assert.equal(empty.logs[0][3], 502);
  assert.ok(!empty.writes.join('').includes('event: response.completed'));
  const timeout = fixture({ slow: true, options: { conversionDrainTimeoutMs: 5 } });
  await tick();
  timeout.deliver();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(timeout.logs.length, 1);
  assert.equal(timeout.logs[0][3], 502);
  assert.equal(timeout.logs[0][4].errorCode, 'downstream_stream_drain_timeout');
  const truncated = fixture({
    body:
      frame({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_fixture',
                  function: { name: 'probe', arguments: '{"ok":true}' },
                },
              ],
            },
            finish_reason: 'length',
          },
        ],
      }) + 'data: [DONE]\n\n',
  });
  await tick();
  truncated.deliver();
  await tick();
  assert.equal(truncated.logs[0][3], 200);
  assert.ok(truncated.writes.join('').includes('event: response.incomplete'));
  assert.ok(!truncated.writes.join('').includes('response.function_call_arguments.done'));
  const toolItems = truncated.writes
    .flatMap((event) => event.split(/\r?\n/))
    .filter((line) => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]')
    .map((line) => JSON.parse(line.slice(5)))
    .filter(
      (event) => event.type === 'response.output_item.done' && event.item.type === 'function_call'
    );
  assert.equal(toolItems.length, 1);
  assert.equal(toolItems[0].item.status, 'incomplete');
  for (const item of [
    rejection,
    early,
    cancel,
    requestAbort,
    downstreamError,
    slow,
    overflow,
    empty,
    timeout,
    truncated,
  ]) {
    const outcomes = item.events.filter((event) => event[0] === 'workbuddy_context_outcome');
    assert.equal(outcomes.length, 1, 'exactly one context terminal per request');
    assert.equal(outcomes[0][1].finalStatus, item.logs[0][3]);
    if (item.logs[0][3] >= 400) assert.equal(outcomes[0][1].finalOk, false);
  }
  process.stdout.write('workbuddy-responses-flow.test.js passed\n');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
