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
    return String(modeText || '').split(/[,\s]+/).some((item) => item.toLowerCase() === value);
  }

  function isRawProgressCommentEnabled() {
    return /^(1|true|comment|comments)$/i.test(String(currentRawProgressMode() || ''));
  }

  function isRawProgressVisibleEnabled() {
    const mode = currentRawProgressMode();
    return progressModeIncludes(mode, 'visible') ||
      progressModeIncludes(mode, 'content') ||
      progressModeIncludes(mode, 'text');
  }

  function isLogProgressVisibleEnabled() {
    const mode = currentLiveLogProgressMode();
    return progressModeIncludes(mode, 'visible') ||
      progressModeIncludes(mode, 'content') ||
      progressModeIncludes(mode, 'text');
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

  function formatTraeRawVisibleText(summary) {
    if (!summary || !summary.event) return '';
    if (summary.event === 'plan_item') {
      const tool = summary.toolName ? ` tool=${summary.toolName}` : '';
      const status = summary.toolStatus || summary.agentStatus;
      return `[Trae plan_item${tool}${status ? ` status=${status}` : ''}]`;
    }
    if (summary.event === 'model_config') {
      return `[Trae model_config${summary.modelName ? ` model=${summary.modelName}` : ''}]`;
    }
    if (summary.event === 'token_usage') {
      const input = summary.input == null ? '' : ` input=${summary.input}`;
      const output = summary.output == null ? '' : ` output=${summary.output}`;
      return `[Trae token_usage${input}${output}]`;
    }
    if (summary.event === 'timing_events') {
      const first = summary.firstSseMs == null ? '' : ` first_sse=${summary.firstSseMs}ms`;
      const server = summary.serverMs == null ? '' : ` server=${summary.serverMs}ms`;
      return `[Trae timing${first}${server}]`;
    }
    if (summary.event === 'done') {
      return `[Trae done${summary.status ? ` status=${summary.status}` : ''}]`;
    }
    return `[Trae ${summary.event}${summary.status ? ` status=${summary.status}` : ''}]`;
  }

  function formatTraeLogVisibleText(progress) {
    if (!progress || progress.source !== 'trae-log') return '';
    if (progress.kind === 'tool_start') return `[Trae tool_start command=${progress.command || 'unknown'}]`;
    if (progress.kind === 'tool_end') return `[Trae tool_end command=${progress.command || 'unknown'}${progress.costMs == null ? '' : ` cost=${progress.costMs}ms`}]`;
    if (progress.kind === 'ide_command') return `[Trae ide_command command=${progress.command || 'unknown'}]`;
    if (progress.kind === 'plan_confirm') return `[Trae plan_confirm${progress.toolName ? ` tool=${progress.toolName}` : ''}${progress.confirmStatus ? ` status=${progress.confirmStatus}` : ''}]`;
    if (progress.kind === 'run_command_trace') return `[Trae run_command_trace${progress.command ? ` command=${progress.command}` : ''}${progress.exitCode == null ? '' : ` exit=${progress.exitCode}`}]`;
    if (progress.kind === 'agent_prepare') return '[Trae agent_prepare]';
    if (progress.kind === 'model_first_token') return '[Trae model_first_token]';
    if (progress.kind === 'agent_stream_done') return '[Trae agent_stream_done]';
    if (progress.kind === 'agent_status') return `[Trae agent_status${progress.status ? ` status=${progress.status}` : ''}]`;
    if (progress.kind === 'model_final_token') return `[Trae model_final_token${progress.costMs == null ? '' : ` cost=${progress.costMs}ms`}]`;
    return progress.kind ? `[Trae ${progress.kind}]` : '';
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
    const roots = fs.readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}$/.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(base, entry.name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(fullPath).mtimeMs; } catch (e) {}
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
        try { mtimeMs = fs.statSync(fullPath).mtimeMs; } catch (e) {}
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
    const emit = (event) => { if (event) writeProgress(event); };
    const poll = () => {
      for (const item of candidates) {
        let stat;
        let offset = offsets.get(item.file);
        try { stat = fs.statSync(item.file); } catch (e) { continue; }
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
    summarizeTraeRawEvent,
    formatTraeRawVisibleText,
    formatTraeLogVisibleText,
    writeRawProgress,
    startTraeLogProgress,
  };
}

module.exports = {
  createTraeBridgeProgress,
};
