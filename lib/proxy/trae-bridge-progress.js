/**
 * Trae Bridge 进度层: raw event + log 解析与人类可读格式化
 *
 * 拆分自 trae-bridge-runtime.js:
 *   - raw_event 通道: 归一化、概要、可见文本、可选 SSE comment 写入
 *   - log 通道:  轮询 Trae 桌面日志目录,解析关键事件为 progress payload
 *   - 三种可见性模式: 关闭 / SSE comment / 注入到客户端文本流
 *
 * 公开 API (createTraeBridgeProgress(deps)):
 *   - isRawProgressCommentEnabled / isRawProgressVisibleEnabled
 *   - isLogProgressVisibleEnabled
 *   - summarizeTraeRawEvent
 *   - formatTraeRawVisibleText / formatTraeLogVisibleText
 *   - writeRawProgress(clientRes, rawEvent, writeVisibleText)
 *   - startTraeLogProgress(writeProgress) -> stop()
 */

const fs = require('fs');
const path = require('path');

function createTraeBridgeProgress({
  liveLogProgressMode = process.env.TRAE_BRIDGE_LOG_PROGRESS || '',
  rawProgressMode = process.env.TRAE_BRIDGE_RAW_PROGRESS || '',
  liveLogProgress = process.env.TRAE_BRIDGE_LOG_PROGRESS !== '0',
  getTraeDebugSettings,
  traeLogRoot,
}) {
  function currentDebugSettings() {
    if (typeof getTraeDebugSettings !== 'function') return {};
    try {
      return getTraeDebugSettings() || {};
    } catch (err) {
      return {};
    }
  }

  function currentRawProgressMode() {
    const settings = currentDebugSettings();
    return settings.rawProgressMode == null ? rawProgressMode : settings.rawProgressMode;
  }

  function currentLiveLogProgressMode() {
    const settings = currentDebugSettings();
    return settings.logProgressMode == null ? liveLogProgressMode : settings.logProgressMode;
  }

  function currentLiveLogProgress() {
    const settings = currentDebugSettings();
    return settings.liveLogProgress == null ? liveLogProgress : Boolean(settings.liveLogProgress);
  }

  function progressModeIncludes(modeText, value) {
    return String(modeText || '')
      .split(/[,\s]+/)
      .some((item) => item.toLowerCase() === value);
  }

  function isRawProgressCommentEnabled() {
    return /^(1|true|comment|comments)$/i.test(String(currentRawProgressMode() || ''));
  }

  function isRawProgressVisibleEnabled() {
    const mode = currentRawProgressMode();
    return (
      progressModeIncludes(mode, 'visible') ||
      progressModeIncludes(mode, 'content') ||
      progressModeIncludes(mode, 'text')
    );
  }

  function isLogProgressVisibleEnabled() {
    const mode = currentLiveLogProgressMode();
    return (
      progressModeIncludes(mode, 'visible') ||
      progressModeIncludes(mode, 'content') ||
      progressModeIncludes(mode, 'text')
    );
  }

  function isClaudeProcessProgressEnabled() {
    return claudeProcessProgressStyle() !== '';
  }

  function claudeProcessProgressStyle() {
    const mode = currentRawProgressMode();
    if (
      progressModeIncludes(mode, 'claude-text') ||
      progressModeIncludes(mode, 'process-text') ||
      progressModeIncludes(mode, 'text-process')
    ) {
      return 'text';
    }
    if (
      progressModeIncludes(mode, 'claude-thinking') ||
      progressModeIncludes(mode, 'claude-process') ||
      progressModeIncludes(mode, 'thinking')
    ) {
      return 'thinking';
    }
    return progressModeIncludes(mode, 'claude') || progressModeIncludes(mode, 'process')
      ? 'thinking'
      : '';
  }

  function normalizeRawEventPayload(rawEvent) {
    const payload =
      rawEvent && rawEvent.payload && typeof rawEvent.payload === 'object' ? rawEvent.payload : {};
    if (payload.payload && typeof payload.payload === 'object' && typeof payload.event === 'string')
      return payload.payload;
    return payload;
  }

  function shortRawId(value) {
    const text = String(value || '');
    if (!text) return '';
    return text.length > 12 ? `${text.slice(0, 6)}..${text.slice(-4)}` : text;
  }

  function rawTextChars(value) {
    if (typeof value === 'string') return value.length;
    if (value && typeof value === 'object' && typeof value.chars === 'number') return value.chars;
    return undefined;
  }

  function objectKeys(value, limit = 6) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.keys(value).filter(Boolean).slice(0, limit);
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
      summary.agentName = payload.agent_name || payload.agent_id;
      summary.strategy = payload.agent_task_service_strategy;
      const modelInfo =
        payload.user_message_context &&
        payload.user_message_context.model_info &&
        typeof payload.user_message_context.model_info === 'object'
          ? payload.user_message_context.model_info
          : null;
      if (modelInfo) {
        summary.modelName = modelInfo.model_name || modelInfo.display_model_name;
        summary.configName = modelInfo.config_name;
      }
    } else if (eventName === 'model_config') {
      summary.modelName = payload.model_name;
      summary.configName = payload.config_name;
    } else if (eventName === 'plan_item') {
      summary.planItemId = payload.id;
      summary.taskId = payload.task_id;
      summary.agentRunId = payload.agent_run_id;
      summary.agentStatus = payload.agent_status && payload.agent_status.status;
      summary.runMode = payload.agent_status && payload.agent_status.run_mode;
      summary.reasoningChars = rawTextChars(payload.reasoning_content);
      summary.thoughtChars = rawTextChars(payload.thought);
      if (payload.tool_call_info && typeof payload.tool_call_info === 'object') {
        summary.toolCallId = payload.tool_call_info.id;
        summary.toolName = payload.tool_call_info.name || undefined;
        summary.toolStatus =
          (payload.tool_call_info.result && payload.tool_call_info.result.status) ||
          payload.tool_call_info.toolcall_status;
        summary.toolParamKeys = objectKeys(payload.tool_call_info.params);
        summary.toolResultKeys = objectKeys(payload.tool_call_info.result);
      }
    } else if (eventName === 'token_usage') {
      summary.input = payload.input;
      summary.output = payload.output;
      summary.promptTokens = payload.prompt_tokens || payload.prompt_tokens_total;
      summary.completionTokens = payload.completion_tokens || payload.completion_tokens_total;
      summary.totalTokens =
        payload.total_tokens || payload.total_tokens_total || payload.last_turn_total_tokens;
      summary.reasoningTokens = payload.reasoning_tokens || payload.reasoning_tokens_total;
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
      if (typeof summary.chatStartTime === 'number' && typeof summary.chatEndTime === 'number') {
        summary.durationMs = Math.max(0, summary.chatEndTime - summary.chatStartTime);
      }
    } else {
      summary.status = payload.status;
      summary.code = payload.code;
    }
    Object.keys(summary).forEach((key) => {
      if (summary[key] == null || summary[key] === '') delete summary[key];
    });
    return summary;
  }

  function formatRawKeyList(prefix, values) {
    if (!Array.isArray(values) || !values.length) return '';
    return ` ${prefix}=${values.join(',')}`;
  }

  function rawIdentity(summary) {
    if (!summary || !summary.event) return '';
    return [
      summary.event,
      summary.planItemId,
      summary.taskId,
      summary.toolCallId,
      summary.toolName,
      summary.toolStatus,
      summary.agentStatus,
      summary.reasoningChars,
      summary.thoughtChars,
      summary.modelName,
      summary.configName,
      summary.input,
      summary.output,
      summary.promptTokens,
      summary.completionTokens,
      summary.totalTokens,
      summary.firstSseMs,
      summary.serverMs,
      summary.status,
    ]
      .filter((item) => item != null && item !== '')
      .join('|');
  }

  function createTraeRawProgressDeduper(limit = 160) {
    const seen = new Set();
    const order = [];
    return function shouldEmit(summary) {
      const key = rawIdentity(summary);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      order.push(key);
      while (order.length > limit) {
        const old = order.shift();
        seen.delete(old);
      }
      return true;
    };
  }

  function formatTraeRawVisibleText(summary) {
    if (!summary || !summary.event) return '';
    if (summary.event === 'metadata') {
      const agent = summary.agentName ? ` agent=${summary.agentName}` : '';
      const model = summary.modelName ? ` model=${summary.modelName}` : '';
      const client = summary.requestClient ? ` client=${summary.requestClient}` : '';
      const strategy = summary.strategy ? ` strategy=${summary.strategy}` : '';
      const status = summary.status ? ` status=${summary.status}` : '';
      return `[Trae metadata${agent}${model}${client}${strategy}${status}]`;
    }
    if (summary.event === 'plan_item') {
      const tool = summary.toolName ? ` tool=${summary.toolName}` : '';
      const status = summary.toolStatus || summary.agentStatus;
      const run = summary.runMode ? ` run=${summary.runMode}` : '';
      const reasoning =
        summary.reasoningChars == null ? '' : ` reasoning_chars=${summary.reasoningChars}`;
      const thought = summary.thoughtChars == null ? '' : ` thought_chars=${summary.thoughtChars}`;
      const task = summary.taskId ? ` task=${shortRawId(summary.taskId)}` : '';
      const params = formatRawKeyList('params', summary.toolParamKeys);
      return `[Trae plan_item${tool}${status ? ` status=${status}` : ''}${run}${reasoning}${thought}${task}${params}]`;
    }
    if (summary.event === 'model_config') {
      const model = summary.modelName ? ` model=${summary.modelName}` : '';
      const config = summary.configName ? ` config=${summary.configName}` : '';
      return `[Trae model_config${model}${config}]`;
    }
    if (summary.event === 'token_usage') {
      const input = summary.input == null ? '' : ` input=${summary.input}`;
      const output = summary.output == null ? '' : ` output=${summary.output}`;
      const prompt = summary.promptTokens == null ? '' : ` prompt=${summary.promptTokens}`;
      const completion =
        summary.completionTokens == null ? '' : ` completion=${summary.completionTokens}`;
      const total = summary.totalTokens == null ? '' : ` total=${summary.totalTokens}`;
      const reasoning =
        summary.reasoningTokens == null ? '' : ` reasoning=${summary.reasoningTokens}`;
      return `[Trae token_usage${input}${output}${prompt}${completion}${total}${reasoning}]`;
    }
    if (summary.event === 'timing_events') {
      const model = summary.modelName ? ` model=${summary.modelName}` : '';
      const queue = summary.queueMs == null ? '' : ` queue=${summary.queueMs}ms`;
      const first = summary.firstSseMs == null ? '' : ` first_sse=${summary.firstSseMs}ms`;
      const server = summary.serverMs == null ? '' : ` server=${summary.serverMs}ms`;
      const gateway = summary.gatewayMs == null ? '' : ` gateway=${summary.gatewayMs}ms`;
      return `[Trae timing${model}${queue}${first}${server}${gateway}]`;
    }
    if (summary.event === 'done') {
      const duration = summary.durationMs == null ? '' : ` duration=${summary.durationMs}ms`;
      return `[Trae done${summary.status ? ` status=${summary.status}` : ''}${duration}]`;
    }
    return `[Trae ${summary.event}${summary.status ? ` status=${summary.status}` : ''}]`;
  }

  function formatTraeLogVisibleText(progress) {
    if (!progress || progress.source !== 'trae-log') return '';
    const command = String(progress.command || '');
    const shortCommand = command.split('.').filter(Boolean).pop() || command || 'unknown';
    if (shortCommand === 'checkRunCommandStatus') return '';
    if (progress.kind === 'tool_start') return `Trae 正在调用工具: ${shortCommand}`;
    if (progress.kind === 'tool_end') {
      const cost = progress.costMs == null ? '' : ` (${progress.costMs}ms)`;
      return `Trae 工具完成: ${shortCommand}${cost}`;
    }
    if (progress.kind === 'ide_command') return `Trae IDE 命令: ${shortCommand}`;
    if (progress.kind === 'plan_confirm') {
      const tool = progress.toolName ? ` ${progress.toolName}` : '';
      const status = progress.confirmStatus ? ` ${progress.confirmStatus}` : '';
      return `Trae 已确认执行${tool}${status}`;
    }
    if (progress.kind === 'run_command_trace') {
      const exit = progress.exitCode == null ? '' : ` exit=${progress.exitCode}`;
      return `Trae 命令执行${exit}`;
    }
    if (progress.kind === 'agent_prepare') return 'Trae Agent 准备中';
    if (progress.kind === 'model_first_token') return 'Trae 模型开始输出';
    if (progress.kind === 'agent_stream_done') return 'Trae Agent 流结束';
    if (progress.kind === 'agent_status')
      return progress.status ? `Trae Agent 状态: ${progress.status}` : '';
    if (progress.kind === 'model_final_token') {
      const cost = progress.costMs == null ? '' : ` (${progress.costMs}ms)`;
      return `Trae 模型输出完成${cost}`;
    }
    return progress.kind ? `Trae ${progress.kind}` : '';
  }

  function writeRawProgress(clientRes, rawEvent, writeVisibleText) {
    const summary = summarizeTraeRawEvent(rawEvent);
    if (!summary || !summary.event) return;
    if (isRawProgressCommentEnabled()) {
      clientRes.write(': trae-raw ' + JSON.stringify(summary) + '\n\n');
    }
    if (isRawProgressVisibleEnabled() && writeVisibleText) {
      const marker = formatTraeRawVisibleText(summary);
      if (marker) writeVisibleText(marker);
    }
  }

  function getLatestTraeLogRoot() {
    if (traeLogRoot) return traeLogRoot;
    const base = process.env.APPDATA ? path.join(process.env.APPDATA, 'Trae', 'logs') : '';
    if (!base || !fs.existsSync(base)) return null;
    const roots = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}$/.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(base, entry.name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(fullPath).mtimeMs;
        } catch (e) {}
        return { fullPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return (roots[0] && roots[0].fullPath) || null;
  }

  function getLatestAgentLog(root) {
    const modularDir = path.join(root, 'Modular');
    if (!fs.existsSync(modularDir)) return null;
    const logs = fs
      .readdirSync(modularDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^ai-agent_.*_stdout\.log$/.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(modularDir, entry.name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(fullPath).mtimeMs;
        } catch (e) {}
        return { fullPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return (logs[0] && logs[0].fullPath) || null;
  }

  function isNoisyTraeLogCommand(command) {
    return /(?:getConfigurationValue|getAppPrivacyMode|getABTestConfigByKey|getDynamicConfig|getAutoRunConfig)$/.test(
      command || ''
    );
  }

  function parseTraeLogLine(source, line) {
    if (!line) return null;
    if (source === 'renderer') {
      let match = line.match(/\[ai-chat\]\[sendToAgent\].*"sessionId":"([^"]+)"/);
      if (match) return { source: 'trae-log', kind: 'send_to_agent', sessionId: match[1] };
      match = line.match(/\[CommandAdapter\]\[execute_command\].*command:([^\s]+) timeout:(\d+)/);
      if (match && !isNoisyTraeLogCommand(match[1])) {
        return {
          source: 'trae-log',
          kind: 'ide_command',
          command: match[1],
          timeoutMs: Number(match[2]),
        };
      }
      match = line.match(/\[tooling\] \[message:([^\]]*)\] ([0-9a-f-]+) ([^\s]+) start/);
      if (match && !isNoisyTraeLogCommand(match[3])) {
        return {
          source: 'trae-log',
          kind: 'tool_start',
          messageId: match[1] || undefined,
          callId: match[2],
          command: match[3],
        };
      }
      match = line.match(/\[tooling\] ([0-9a-f-]+) ([^\s]+) end, cost=(\d+)ms/);
      if (match && !isNoisyTraeLogCommand(match[2])) {
        return {
          source: 'trae-log',
          kind: 'tool_end',
          callId: match[1],
          command: match[2],
          costMs: Number(match[3]),
        };
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
            isCurrentSession: info.isCurrentSession,
          };
        } catch (e) {}
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
            totalDuration: data.metrics && data.metrics.total_duration,
          };
        } catch (e) {}
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
      if (line.includes('before prepare loop'))
        return { source: 'trae-log', kind: 'agent_prepare', ...ids };
      if (line.includes('first token flushed thought'))
        return { source: 'trae-log', kind: 'model_first_token', ...ids };
      if (line.includes('start_agent_gen_plan') && line.includes('DONE'))
        return { source: 'trae-log', kind: 'agent_stream_done', ...ids };
      if (line.includes('[AgentStatus] received')) {
        return {
          source: 'trae-log',
          kind: 'agent_status',
          status: line.includes('completed') ? 'completed' : 'unknown',
          ...ids,
        };
      }
      if (line.includes('plan final token cost')) {
        const cost = line.match(/plan final token cost: (\d+)ms/);
        return {
          source: 'trae-log',
          kind: 'model_final_token',
          costMs: cost ? Number(cost[1]) : undefined,
          ...ids,
        };
      }
    }
    return null;
  }

  function startTraeLogProgress(writeProgress) {
    if (!currentLiveLogProgress() || !writeProgress) return () => {};
    let root;
    try {
      root = getLatestTraeLogRoot();
    } catch (e) {
      return () => {};
    }
    if (!root) return () => {};
    const candidates = [
      { source: 'renderer', file: path.join(root, 'window1', 'renderer.log') },
      { source: 'agent', file: getLatestAgentLog(root) },
    ].filter((item) => item.file && fs.existsSync(item.file));
    if (!candidates.length) return () => {};
    const offsets = new Map();
    const partials = new Map();
    for (const item of candidates) {
      try {
        offsets.set(item.file, fs.statSync(item.file).size);
        partials.set(item.file, '');
      } catch (e) {}
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
        } catch (e) {
          continue;
        }
        if (typeof offset !== 'number' || stat.size < offset) offset = 0;
        if (stat.size <= offset) continue;
        const length = Math.min(stat.size - offset, 512 * 1024);
        const readOffset = stat.size - offset > length ? stat.size - length : offset;
        let text;
        try {
          const fd = fs.openSync(item.file, 'r');
          const buffer = Buffer.alloc(length);
          fs.readSync(fd, buffer, 0, length, readOffset);
          fs.closeSync(fd);
          text = buffer.toString('utf8');
          offsets.set(item.file, stat.size);
        } catch (e) {
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

  return {
    isRawProgressCommentEnabled,
    isRawProgressVisibleEnabled,
    isLogProgressVisibleEnabled,
    isClaudeProcessProgressEnabled,
    claudeProcessProgressStyle,
    summarizeTraeRawEvent,
    createTraeRawProgressDeduper,
    formatTraeRawVisibleText,
    formatTraeLogVisibleText,
    writeRawProgress,
    startTraeLogProgress,
  };
}

module.exports = {
  createTraeBridgeProgress,
};
