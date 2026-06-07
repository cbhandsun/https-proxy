const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function createTraeBridgeRuntime({
  makeRequest,
  getTraeOfficialBridgeUrl,
  normalizeTraeBridgeText,
  buildTraeBridgeOpenAIChatCompletion,
  openAIChatToResponses,
  processOpenAIChatSseChunkToResponses,
  flushOpenAIChatSseToResponses,
  writeClaudeSseEvent,
  fallbackId,
  stableCreated,
  bridgeTimeoutMs = Number(process.env.TRAE_BRIDGE_TIMEOUT_MS || 5 * 60 * 1000),
  liveHeartbeatMs = Number(process.env.TRAE_BRIDGE_LIVE_HEARTBEAT_MS || 2000),
  liveLogProgress = process.env.TRAE_BRIDGE_LOG_PROGRESS !== '0',
  rawProgressMode = process.env.TRAE_BRIDGE_RAW_PROGRESS || '',
  traeLogRoot,
}) {
  let bridgeQueue = Promise.resolve();

  function enqueueBridgeRequest(fn) {
    const run = bridgeQueue.then(fn, fn);
    bridgeQueue = run.catch(() => {});
    return run;
  }

  async function callTraeOfficialBridge(payload) {
    return enqueueBridgeRequest(async () => {
      const body = JSON.stringify(payload);
      const bridgeUrl = getTraeOfficialBridgeUrl('/v1/chat');
      const res = await makeRequest(bridgeUrl, {
        method: 'POST',
        timeout: bridgeTimeoutMs,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body)
        }
      }, body);
      let parsed;
      try {
        parsed = JSON.parse(res.body || '{}');
      } catch (err) {
        parsed = { ok: false, error: 'Trae bridge returned non-JSON response', body: res.body };
      }
      if (res.statusCode < 200 || res.statusCode >= 300 || parsed.ok === false) {
        const message = parsed && (parsed.error || parsed.message) || `Trae bridge failed with HTTP ${res.statusCode}`;
        const error = new Error(String(message));
        error.statusCode = res.statusCode;
        error.bridgeUrl = bridgeUrl;
        throw error;
      }
      return { text: normalizeTraeBridgeText(parsed), raw: parsed, bridgeUrl };
    });
  }

  function parseSseEvents(state, chunkText, onEvent) {
    state.buffer += chunkText;
    const events = state.buffer.split(/\r?\n\r?\n/);
    state.buffer = events.pop();
    for (const eventText of events) {
      const lines = eventText.split(/\r?\n/);
      let eventName = 'message';
      const dataLines = [];
      for (const line of lines) {
        if (line.indexOf('event:') === 0) eventName = line.slice(6).trim() || 'message';
        if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) continue;
      let payload = {};
      try {
        payload = JSON.parse(dataLines.join('\n'));
      } catch (err) {
        payload = { raw: dataLines.join('\n') };
      }
      onEvent(eventName, payload);
    }
  }

  function formatTraeInteraction(interaction) {
    if (!interaction || typeof interaction !== 'object') return '';
    const type = interaction.type || interaction.toolName || 'interaction';
    if (type === 'RunCommand') {
      const cwd = interaction.cwd ? ` cwd=${interaction.cwd}` : '';
      const command = interaction.command ? ` command=${interaction.command}` : '';
      return `[Trae ${type}${cwd}${command}]`;
    }
    if (type === 'AskUserQuestion') {
      const questions = Array.isArray(interaction.questions) ? interaction.questions.map((item) => item && (item.question || item.text || item.title)).filter(Boolean).join('; ') : '';
      return `[Trae ${type}${questions ? ': ' + questions : ''}]`;
    }
    if (type === 'NotifyUser') {
      const explanation = interaction.explanation ? `: ${interaction.explanation}` : '';
      return `[Trae ${type}${explanation}]`;
    }
    return `[Trae ${type}]`;
  }

  function getTraeBridgeErrorMessage(error) {
    return error && error.message ? String(error.message) : String(error || 'Trae bridge stream error');
  }

  function formatTraeBridgeStreamError(error) {
    const message = getTraeBridgeErrorMessage(error);
    const label = /not waiting input|busy|running/i.test(message) ? 'busy' : 'error';
    return `[Trae bridge ${label}: ${message}]`;
  }

  function startLiveHeartbeat(writeHeartbeat) {
    if (!writeHeartbeat || liveHeartbeatMs <= 0) return () => {};
    const startedAt = Date.now();
    const timer = setInterval(() => {
      writeHeartbeat({
        phase: 'running',
        elapsedMs: Date.now() - startedAt,
        source: 'proxy'
      });
    }, liveHeartbeatMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }

  function isRawProgressEnabled() {
    return /^(1|true|comment|comments)$/i.test(String(rawProgressMode || ''));
  }

  function normalizeRawEventPayload(rawEvent) {
    const payload = rawEvent && rawEvent.payload && typeof rawEvent.payload === 'object' ? rawEvent.payload : {};
    if (payload.payload && typeof payload.payload === 'object' && typeof payload.event === 'string') return payload.payload;
    return payload;
  }

  function summarizeTraeRawEvent(rawEvent) {
    if (!rawEvent || typeof rawEvent !== 'object') return null;
    const payload = normalizeRawEventPayload(rawEvent);
    const summary = {
      source: 'trae-raw',
      event: rawEvent.event || payload.event || '',
      ts: rawEvent.ts,
      service: rawEvent.service,
      method: rawEvent.method,
      channelId: rawEvent.channelId,
      sessionId: rawEvent.sessionId || payload.session_id,
      agentMessageId: rawEvent.agentMessageId || payload.message_id,
    };
    const eventName = summary.event;
    if (eventName === 'metadata') {
      summary.status = payload.status || payload.metadata_status;
      summary.traceId = payload.trace_id;
      summary.requestClient = payload.request_client;
      summary.agentType = payload.agent_type;
      summary.strategy = payload.agent_task_service_strategy;
    } else if (eventName === 'model_config') {
      summary.modelName = payload.model_name;
      summary.configName = payload.config_name;
    } else if (eventName === 'plan_item') {
      summary.planItemId = payload.id;
      summary.taskId = payload.task_id;
      summary.agentStatus = payload.agent_status && payload.agent_status.status;
      summary.runMode = payload.agent_status && payload.agent_status.run_mode;
      if (payload.tool_call_info && typeof payload.tool_call_info === 'object') {
        summary.toolCallId = payload.tool_call_info.id;
        summary.toolName = payload.tool_call_info.name || undefined;
        summary.toolStatus = payload.tool_call_info.result && payload.tool_call_info.result.status;
      }
    } else if (eventName === 'token_usage') {
      summary.input = payload.input;
      summary.output = payload.output;
    } else if (eventName === 'timing_events') {
      const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
      summary.modelName = payload.model_name;
      summary.logId = payload.logid;
      summary.queueMs = data.svr_01_queue_timing;
      summary.firstSseMs = data.svr_10_first_sse_event_timing;
      summary.serverMs = data.svr_11_server_processing_time;
      summary.gatewayMs = data.svr_11_gateway_server_processing_time;
    } else if (eventName === 'done') {
      summary.status = payload.status;
      summary.chatStartTime = payload.chat_start_time;
      summary.chatEndTime = payload.chat_end_time;
    } else {
      summary.status = payload.status;
      summary.code = payload.code;
    }
    Object.keys(summary).forEach((key) => {
      if (summary[key] == null || summary[key] === '') delete summary[key];
    });
    return summary;
  }

  function writeRawProgressComment(clientRes, rawEvent) {
    if (!isRawProgressEnabled()) return;
    const summary = summarizeTraeRawEvent(rawEvent);
    if (!summary || !summary.event) return;
    clientRes.write(': trae-raw ' + JSON.stringify(summary) + '\n\n');
  }

  function getLatestTraeLogRoot() {
    if (traeLogRoot) return traeLogRoot;
    const base = process.env.APPDATA ? path.join(process.env.APPDATA, 'Trae', 'logs') : '';
    if (!base || !fs.existsSync(base)) return null;
    const roots = fs.readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}$/.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(base, entry.name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(fullPath).mtimeMs;
        } catch {}
        return { fullPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return roots[0] && roots[0].fullPath || null;
  }

  function getLatestAgentLog(root) {
    const modularDir = path.join(root, 'Modular');
    if (!fs.existsSync(modularDir)) return null;
    const logs = fs.readdirSync(modularDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^ai-agent_.*_stdout\.log$/.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(modularDir, entry.name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(fullPath).mtimeMs;
        } catch {}
        return { fullPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return logs[0] && logs[0].fullPath || null;
  }

  function isNoisyTraeLogCommand(command) {
    return /(?:getConfigurationValue|getAppPrivacyMode|getABTestConfigByKey|getDynamicConfig|getAutoRunConfig)$/.test(command || '');
  }

  function parseTraeLogLine(source, line) {
    if (!line) return null;
    if (source === 'renderer') {
      let match = line.match(/\[ai-chat\]\[sendToAgent\].*"sessionId":"([^"]+)"/);
      if (match) return { source: 'trae-log', kind: 'send_to_agent', sessionId: match[1] };
      match = line.match(/\[CommandAdapter\]\[execute_command\].*command:([^\s]+) timeout:(\d+)/);
      if (match && !isNoisyTraeLogCommand(match[1])) {
        return { source: 'trae-log', kind: 'ide_command', command: match[1], timeoutMs: Number(match[2]) };
      }
      match = line.match(/\[tooling\] \[message:([^\]]*)\] ([0-9a-f-]+) ([^\s]+) start/);
      if (match && !isNoisyTraeLogCommand(match[3])) {
        return { source: 'trae-log', kind: 'tool_start', messageId: match[1] || undefined, callId: match[2], command: match[3] };
      }
      match = line.match(/\[tooling\] ([0-9a-f-]+) ([^\s]+) end, cost=(\d+)ms/);
      if (match && !isNoisyTraeLogCommand(match[2])) {
        return { source: 'trae-log', kind: 'tool_end', callId: match[1], command: match[2], costMs: Number(match[3]) };
      }
      match = line.match(/\[ai-chat\]\[PlanItemStreamParser\] confirm_info received (\{.*\})/);
      if (match) {
        try {
          const info = JSON.parse(match[1]);
          return {
            source: 'trae-log',
            kind: 'plan_confirm',
            sessionId: info.sessionId,
            toolName: info.toolName,
            confirmStatus: info.confirmStatus,
            autoConfirm: info.autoConfirm,
            isCurrentSession: info.isCurrentSession
          };
        } catch {}
      }
      match = line.match(/\[ToolingTerminalTrace\]toolcall_run_command_tracing (\{.*\})/);
      if (match) {
        try {
          const data = JSON.parse(match[1]);
          return {
            source: 'trae-log',
            kind: 'run_command_trace',
            command: data.categories && data.categories.command,
            exitCode: data.categories && data.categories.exitCode,
            lastStage: data.categories && data.categories.last_stage,
            totalDuration: data.metrics && data.metrics.total_duration
          };
        } catch {}
      }
      return null;
    }
    if (source === 'agent') {
      const ids = {};
      const match = line.match(/trace_id="([^"]+)".*task_id=([^\s]+).*message_id=([^\s]+)/);
      if (match) {
        ids.traceId = match[1];
        ids.taskId = match[2];
        ids.messageId = match[3];
      }
      if (line.includes('before prepare loop')) return { source: 'trae-log', kind: 'agent_prepare', ...ids };
      if (line.includes('first token flushed thought')) return { source: 'trae-log', kind: 'model_first_token', ...ids };
      if (line.includes('start_agent_gen_plan') && line.includes('DONE')) return { source: 'trae-log', kind: 'agent_stream_done', ...ids };
      if (line.includes('[AgentStatus] received')) {
        return { source: 'trae-log', kind: 'agent_status', status: line.includes('completed') ? 'completed' : 'unknown', ...ids };
      }
      if (line.includes('plan final token cost')) {
        const cost = line.match(/plan final token cost: (\d+)ms/);
        return { source: 'trae-log', kind: 'model_final_token', costMs: cost ? Number(cost[1]) : undefined, ...ids };
      }
    }
    return null;
  }

  function startTraeLogProgress(writeProgress) {
    if (!liveLogProgress || !writeProgress) return () => {};
    let root;
    try {
      root = getLatestTraeLogRoot();
    } catch {
      return () => {};
    }
    if (!root) return () => {};
    const candidates = [
      { source: 'renderer', file: path.join(root, 'window1', 'renderer.log') },
      { source: 'agent', file: getLatestAgentLog(root) }
    ].filter((item) => item.file && fs.existsSync(item.file));
    if (!candidates.length) return () => {};
    const offsets = new Map();
    const partials = new Map();
    for (const item of candidates) {
      try {
        offsets.set(item.file, fs.statSync(item.file).size);
        partials.set(item.file, '');
      } catch {}
    }
    const emit = (event) => {
      if (event) writeProgress(event);
    };
    const poll = () => {
      for (const item of candidates) {
        let stat;
        let offset = offsets.get(item.file);
        try {
          stat = fs.statSync(item.file);
        } catch {
          continue;
        }
        if (typeof offset !== 'number' || stat.size < offset) offset = 0;
        if (stat.size <= offset) continue;
        const length = Math.min(stat.size - offset, 512 * 1024);
        const readOffset = stat.size - offset > length ? stat.size - length : offset;
        let text = '';
        try {
          const fd = fs.openSync(item.file, 'r');
          const buffer = Buffer.alloc(length);
          fs.readSync(fd, buffer, 0, length, readOffset);
          fs.closeSync(fd);
          text = buffer.toString('utf8');
          offsets.set(item.file, stat.size);
        } catch {
          continue;
        }
        const combined = (partials.get(item.file) || '') + text;
        const lines = combined.split(/\r?\n/);
        partials.set(item.file, lines.pop() || '');
        for (const line of lines) emit(parseTraeLogLine(item.source, line));
      }
    };
    const timer = setInterval(poll, 250);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }

  async function streamTraeOfficialBridge(payload, handlers = {}) {
    return enqueueBridgeRequest(async () => {
      const body = JSON.stringify(payload);
      const bridgeUrl = getTraeOfficialBridgeUrl('/v1/chat/stream');
      let parsedUrl;
      try {
        parsedUrl = new URL(bridgeUrl);
      } catch (err) {
        throw new Error('Invalid Trae bridge stream URL: ' + bridgeUrl);
      }
      const lib = parsedUrl.protocol === 'https:' ? https : http;
      const finalState = { text: '', rawDone: null, bridgeUrl };
      await new Promise((resolve, reject) => {
        const req = lib.request({
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          timeout: bridgeTimeoutMs,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body)
          }
        }, (res) => {
          const sseState = { buffer: '' };
          const errorChunks = [];
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.on('data', (chunk) => errorChunks.push(chunk));
            res.on('end', () => {
              const error = new Error(`Trae bridge stream failed with HTTP ${res.statusCode}: ${Buffer.concat(errorChunks).toString('utf8')}`);
              error.statusCode = res.statusCode;
              error.bridgeUrl = bridgeUrl;
              reject(error);
            });
            return;
          }
          res.on('data', (chunk) => {
            parseSseEvents(sseState, chunk.toString('utf8'), (eventName, eventPayload) => {
              if (eventName === 'text_delta') {
                const text = typeof eventPayload.text === 'string' ? eventPayload.text : '';
                finalState.text += text;
                if (text && handlers.onTextDelta) handlers.onTextDelta(text, eventPayload);
              } else if (eventName === 'interaction') {
                if (handlers.onInteraction) handlers.onInteraction(eventPayload.interaction, eventPayload);
              } else if (eventName === 'progress') {
                if (handlers.onProgress) handlers.onProgress(eventPayload);
              } else if (eventName === 'raw_event') {
                if (handlers.onRawEvent) handlers.onRawEvent(eventPayload);
              } else if (eventName === 'done') {
                finalState.rawDone = eventPayload;
                if (typeof eventPayload.text === 'string') finalState.text = eventPayload.text;
                if (handlers.onDone) handlers.onDone(eventPayload);
              } else if (eventName === 'error') {
                const error = new Error(eventPayload.error || 'Trae bridge stream error');
                error.bridgeUrl = bridgeUrl;
                reject(error);
              }
            });
          });
          res.on('end', () => resolve());
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Trae bridge stream timeout (' + Math.round(bridgeTimeoutMs / 1000) + 's)'));
        });
        req.end(body);
      });
      return finalState;
    });
  }

  function writeTraeBridgeOpenAIStream(clientRes, requestBody, text, model) {
    const created = Math.floor(Date.now() / 1000);
    const id = 'chatcmpl-trae-' + created;
    const responseModel = model || requestBody.model || 'trae-official';
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'access-control-allow-origin': '*'
    });
    const writeChunk = (delta, finishReason = null) => {
      clientRes.write('data: ' + JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: responseModel,
        choices: [{ index: 0, delta, finish_reason: finishReason }]
      }) + '\n\n');
    };
    writeChunk({ role: 'assistant' });
    if (text) writeChunk({ content: String(text) });
    writeChunk({}, 'stop');
    clientRes.write('data: [DONE]\n\n');
    clientRes.end();
  }

  async function writeTraeBridgeOpenAILiveStream(clientRes, requestBody, bridgePayload, model) {
    const created = Math.floor(Date.now() / 1000);
    const id = 'chatcmpl-trae-' + created;
    const responseModel = model || requestBody.model || 'trae-official';
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'access-control-allow-origin': '*'
    });
    const writeChunk = (delta, finishReason = null) => {
      clientRes.write('data: ' + JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: responseModel,
        choices: [{ index: 0, delta, finish_reason: finishReason }]
      }) + '\n\n');
    };
    writeChunk({ role: 'assistant' });
    const writeProgress = (progress) => {
      clientRes.write(': trae-progress ' + JSON.stringify(progress || {}) + '\n\n');
    };
    const stopHeartbeat = startLiveHeartbeat(writeProgress);
    const stopLogProgress = startTraeLogProgress(writeProgress);
    try {
      await streamTraeOfficialBridge(bridgePayload, {
        onTextDelta: (text) => writeChunk({ content: String(text) }),
        onProgress: writeProgress,
        onRawEvent: (rawEvent) => writeRawProgressComment(clientRes, rawEvent),
        onInteraction: (interaction) => {
          const marker = formatTraeInteraction(interaction);
          if (marker) writeChunk({ content: `\n${marker}\n` });
        }
      });
    } catch (err) {
      writeProgress({ phase: 'error', source: 'proxy', message: getTraeBridgeErrorMessage(err) });
      writeChunk({ content: '\n' + formatTraeBridgeStreamError(err) + '\n' });
    } finally {
      stopHeartbeat();
      stopLogProgress();
    }
    writeChunk({}, 'stop');
    clientRes.write('data: [DONE]\n\n');
    clientRes.end();
  }

  function buildTraeBridgeOpenAIResponsesResponse(requestBody, text, model) {
    const chatCompletion = buildTraeBridgeOpenAIChatCompletion({ model: requestBody.model || model }, text, model);
    return openAIChatToResponses(chatCompletion, model || requestBody.model || 'trae-official');
  }

  function writeTraeBridgeOpenAIResponsesStream(clientRes, requestBody, text, model) {
    const seed = { model: requestBody.model || model, input: requestBody.input, route: model };
    const state = {
      id: fallbackId('resp', seed),
      created_at: stableCreated(seed),
      model: requestBody.model || model || 'trae-official',
      buffer: '',
      started: false,
      outputIndex: 0,
      messageId: null,
      textItemStarted: false,
      textItemDone: false,
      text: '',
      pendingToolCalls: [],
      toolCalls: [],
      completedOutputItems: [],
      usage: undefined,
      done: false,
    };
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'access-control-allow-origin': '*'
    });
    const created = Math.floor(Date.now() / 1000);
    const id = 'chatcmpl-trae-' + created;
    const responseModel = model || requestBody.model || 'trae-official';
    const writeChatChunk = (delta, finishReason = null) => {
      processOpenAIChatSseChunkToResponses(clientRes, 'data: ' + JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: responseModel,
        choices: [{ index: 0, delta, finish_reason: finishReason }]
      }) + '\n\n', state);
    };
    if (text) writeChatChunk({ content: String(text) });
    writeChatChunk({}, 'stop');
    flushOpenAIChatSseToResponses(clientRes, state);
    clientRes.end();
  }

  async function writeTraeBridgeOpenAIResponsesLiveStream(clientRes, requestBody, bridgePayload, model) {
    const seed = { model: requestBody.model || model, input: requestBody.input, route: model };
    const state = {
      id: fallbackId('resp', seed),
      created_at: stableCreated(seed),
      model: requestBody.model || model || 'trae-official',
      buffer: '',
      started: false,
      outputIndex: 0,
      messageId: null,
      textItemStarted: false,
      textItemDone: false,
      text: '',
      pendingToolCalls: [],
      toolCalls: [],
      completedOutputItems: [],
      usage: undefined,
      done: false,
    };
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'access-control-allow-origin': '*'
    });
    const created = Math.floor(Date.now() / 1000);
    const id = 'chatcmpl-trae-' + created;
    const responseModel = model || requestBody.model || 'trae-official';
    const writeChatChunk = (delta, finishReason = null) => {
      processOpenAIChatSseChunkToResponses(clientRes, 'data: ' + JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: responseModel,
        choices: [{ index: 0, delta, finish_reason: finishReason }]
      }) + '\n\n', state);
    };
    const writeProgress = (progress) => {
      clientRes.write(': trae-progress ' + JSON.stringify(progress || {}) + '\n\n');
    };
    const stopHeartbeat = startLiveHeartbeat(writeProgress);
    const stopLogProgress = startTraeLogProgress(writeProgress);
    try {
      await streamTraeOfficialBridge(bridgePayload, {
        onTextDelta: (text) => writeChatChunk({ content: String(text) }),
        onProgress: writeProgress,
        onRawEvent: (rawEvent) => writeRawProgressComment(clientRes, rawEvent),
        onInteraction: (interaction) => {
          const marker = formatTraeInteraction(interaction);
          if (marker) writeChatChunk({ content: `\n${marker}\n` });
        }
      });
    } catch (err) {
      writeProgress({ phase: 'error', source: 'proxy', message: getTraeBridgeErrorMessage(err) });
      writeChatChunk({ content: '\n' + formatTraeBridgeStreamError(err) + '\n' });
    } finally {
      stopHeartbeat();
      stopLogProgress();
    }
    writeChatChunk({}, 'stop');
    flushOpenAIChatSseToResponses(clientRes, state);
    clientRes.end();
  }

  function buildTraeBridgeClaudeMessageResponse(requestBody, text, model) {
    const seed = { model: requestBody.model || model, text };
    return {
      id: fallbackId('msg_trae', seed),
      type: 'message',
      role: 'assistant',
      model: model || requestBody.model || 'trae-official',
      content: [{ type: 'text', text: String(text || '') }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0
      }
    };
  }

  function writeTraeBridgeClaudeStream(clientRes, requestBody, text, model) {
    const message = buildTraeBridgeClaudeMessageResponse(requestBody, '', model);
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'access-control-allow-origin': '*'
    });
    writeClaudeSseEvent(clientRes, 'message_start', { type: 'message_start', message });
    writeClaudeSseEvent(clientRes, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    if (text) writeClaudeSseEvent(clientRes, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: String(text) } });
    writeClaudeSseEvent(clientRes, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    writeClaudeSseEvent(clientRes, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: message.usage });
    writeClaudeSseEvent(clientRes, 'message_stop', { type: 'message_stop' });
    clientRes.end();
  }

  async function writeTraeBridgeClaudeLiveStream(clientRes, requestBody, bridgePayload, model) {
    const message = buildTraeBridgeClaudeMessageResponse(requestBody, '', model);
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'access-control-allow-origin': '*'
    });
    let textOpen = false;
    writeClaudeSseEvent(clientRes, 'message_start', { type: 'message_start', message });
    const openText = () => {
      if (textOpen) return;
      textOpen = true;
      writeClaudeSseEvent(clientRes, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    };
    const writePing = () => {
      writeClaudeSseEvent(clientRes, 'ping', { type: 'ping' });
    };
    const stopHeartbeat = startLiveHeartbeat(writePing);
    const stopLogProgress = startTraeLogProgress(writePing);
    try {
      await streamTraeOfficialBridge(bridgePayload, {
        onTextDelta: (text) => {
          openText();
          writeClaudeSseEvent(clientRes, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: String(text) } });
        },
        onProgress: writePing,
        onRawEvent: (rawEvent) => writeRawProgressComment(clientRes, rawEvent),
        onInteraction: (interaction) => {
          const marker = formatTraeInteraction(interaction);
          if (!marker) return;
          openText();
          writeClaudeSseEvent(clientRes, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `\n${marker}\n` } });
        }
      });
    } catch (err) {
      writePing();
      openText();
      writeClaudeSseEvent(clientRes, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\n' + formatTraeBridgeStreamError(err) + '\n' } });
    } finally {
      stopHeartbeat();
      stopLogProgress();
    }
    if (textOpen) writeClaudeSseEvent(clientRes, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    writeClaudeSseEvent(clientRes, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: message.usage });
    writeClaudeSseEvent(clientRes, 'message_stop', { type: 'message_stop' });
    clientRes.end();
  }

  return {
    callTraeOfficialBridge,
    streamTraeOfficialBridge,
    writeTraeBridgeOpenAIStream,
    writeTraeBridgeOpenAILiveStream,
    buildTraeBridgeOpenAIResponsesResponse,
    writeTraeBridgeOpenAIResponsesStream,
    writeTraeBridgeOpenAIResponsesLiveStream,
    buildTraeBridgeClaudeMessageResponse,
    writeTraeBridgeClaudeStream,
    writeTraeBridgeClaudeLiveStream,
  };
}

module.exports = {
  createTraeBridgeRuntime,
};
