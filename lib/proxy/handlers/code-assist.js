/**
 * Google Code Assist (Cloud Code) 上游适配器
 *
 * 当用户使用官方 Google 登录(ya29.* token)且上游协议为 gemini 时,
 * 走 Code Assist 专用 endpoint(daily-cloudcode-pa.googleapis.com),
 * 走 streamGenerateContent / generateContent 方法。
 *
 * 提取自 handlers.js,所有函数为纯函数(无共享可变状态)。
 */
'use strict';

function createCodeAssist({ fallbackId }) {
  function shouldUseCodeAssistUpstream(prepared, apiKey) {
    const protocol =
      prepared && prepared.profile && prepared.profile.protocol
        ? String(prepared.profile.protocol).toLowerCase()
        : '';
    return Boolean(
      prepared &&
      prepared.authMode === 'official-login' &&
      prepared.authProvider === 'google' &&
      protocol === 'gemini' &&
      typeof apiKey === 'string' &&
      apiKey.startsWith('ya29.')
    );
  }

  function codeAssistUrl(method, stream) {
    const base = (
      process.env.CODE_ASSIST_ENDPOINT || 'https://daily-cloudcode-pa.googleapis.com'
    ).replace(/\/$/, '');
    const version = process.env.CODE_ASSIST_API_VERSION || 'v1internal';
    return new URL('/' + version + ':' + method + (stream ? '?alt=sse' : ''), base);
  }

  function codeAssistUserAgent() {
    return process.env.CODE_ASSIST_USER_AGENT || 'antigravity-cli/diagnostic';
  }

  function codeAssistModelSelection(model) {
    const normalized = String(model || '')
      .replace(/^google\//, '')
      .trim();
    const key = normalized.toLowerCase();
    const aliases = {
      'gemini 3.8 flash': 'gemini-3.8-flash-tiered',
      'gemini 3.8 flash (medium)': 'gemini-3.8-flash-tiered',
      'gemini 3.8 flash medium': 'gemini-3.8-flash-tiered',
      'gemini-3.8-flash-medium': 'gemini-3.8-flash-tiered',
      'gemini-3.8-flash': 'gemini-3.8-flash-tiered',
      'gemini-3.8-flash-tiered': 'gemini-3.8-flash-tiered',
      'gemini 3.8 flash (high)': 'gemini-3.8-flash-tiered',
      'gemini 3.8 flash high': 'gemini-3.8-flash-tiered',
      'gemini-3.8-flash-high': 'gemini-3.8-flash-tiered',
      'gemini 3.8 flash (low)': 'gemini-3.8-flash-tiered',
      'gemini 3.8 flash low': 'gemini-3.8-flash-tiered',
      'gemini-3.8-flash-low': 'gemini-3.8-flash-tiered',
      'gemini 3.7 flash': 'gemini-3.7-flash-tiered',
      'gemini 3.7 flash (medium)': 'gemini-3.7-flash-tiered',
      'gemini 3.7 flash medium': 'gemini-3.7-flash-tiered',
      'gemini-3.7-flash-medium': 'gemini-3.7-flash-tiered',
      'gemini-3.7-flash': 'gemini-3.7-flash-tiered',
      'gemini-3.7-flash-tiered': 'gemini-3.7-flash-tiered',
      'gemini 3.7 flash (high)': 'gemini-3.7-flash-tiered',
      'gemini 3.7 flash high': 'gemini-3.7-flash-tiered',
      'gemini-3.7-flash-high': 'gemini-3.7-flash-tiered',
      'gemini 3.7 flash (low)': 'gemini-3.7-flash-tiered',
      'gemini 3.7 flash low': 'gemini-3.7-flash-tiered',
      'gemini-3.7-flash-low': 'gemini-3.7-flash-tiered',
      'gemini 3.6 flash (medium)': 'gemini-3.6-flash-medium',
      'gemini 3.6 flash medium': 'gemini-3.6-flash-medium',
      'gemini-3.6-flash-medium': 'gemini-3.6-flash-medium',
      'gemini-3.6-flash': 'gemini-3.6-flash-medium',
      'gemini 3.6 flash (high)': 'gemini-3.6-flash-high',
      'gemini 3.6 flash high': 'gemini-3.6-flash-high',
      'gemini-3.6-flash-high': 'gemini-3.6-flash-high',
      'gemini 3.6 flash (low)': 'gemini-3.6-flash-low',
      'gemini 3.6 flash low': 'gemini-3.6-flash-low',
      'gemini-3.6-flash-low': 'gemini-3.6-flash-low',
      'gemini 3.5 flash (medium)': 'gemini-3.5-flash-low',
      'gemini 3.5 flash medium': 'gemini-3.5-flash-low',
      'gemini-3.5-flash-medium': 'gemini-3.5-flash-low',
      'gemini-3.5-flash': 'gemini-3.5-flash-low',
      'gemini 3.5 flash (high)': 'gemini-3-flash-agent',
      'gemini 3.5 flash high': 'gemini-3-flash-agent',
      'gemini-3.5-flash-high': 'gemini-3-flash-agent',
      'gemini 3.5 flash (low)': 'gemini-3.5-flash-extra-low',
      'gemini 3.5 flash low': 'gemini-3.5-flash-extra-low',
      'gemini-3.5-flash-extra-low': 'gemini-3.5-flash-extra-low',
      'gemini 3.5 transcribe': 'models/proactive-observer-v10',
      'gemini-3.5-transcribe': 'models/proactive-observer-v10',
      'proactive-observer-v10': 'models/proactive-observer-v10',
      'models/proactive-observer-v10': 'models/proactive-observer-v10',
      'gemini 3.1 flash image': 'gemini-3.1-flash-image',
      'gemini-3.1-flash-image': 'gemini-3.1-flash-image',
      'models/gemini-3.1-flash-image': 'gemini-3.1-flash-image',
      'gemini 3.1 pro (low)': 'gemini-3.1-pro-low',
      'gemini-3.1-pro-low': 'gemini-3.1-pro-low',
      'gemini 3.1 pro (high)': 'gemini-pro-agent',
      'gemini-3.1-pro-high': 'gemini-pro-agent',
      gemini: 'gemini-3.5-flash-low',
      'gemini-3.1': 'gemini-3.1-flash-lite',
      'gemini-3.1-pro': 'gemini-pro-agent',
      'gemini-3.1-flash-preview': 'gemini-3.1-flash-lite',
      'gemini-3-flash-preview': 'gemini-3-flash',
      'claude sonnet 4.6 (thinking)': 'claude-sonnet-4-6',
      'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6',
      'claude opus 4.6 (thinking)': 'claude-opus-4-6-thinking',
      'claude-opus-4-6': 'claude-opus-4-6-thinking',
      'claude-opus-4-6-thinking': 'claude-opus-4-6-thinking',
      'gpt-oss 120b (medium)': 'gpt-oss-120b-medium',
      'gpt-oss-120b': 'gpt-oss-120b-medium',
      'gpt-oss-120b-medium': 'gpt-oss-120b-medium',
    };
    const thinkingLevels = {
      'gemini 3.8 flash (medium)': 'MEDIUM',
      'gemini 3.8 flash medium': 'MEDIUM',
      'gemini-3.8-flash-medium': 'MEDIUM',
      'gemini 3.8 flash (high)': 'HIGH',
      'gemini 3.8 flash high': 'HIGH',
      'gemini-3.8-flash-high': 'HIGH',
      'gemini 3.8 flash (low)': 'LOW',
      'gemini 3.8 flash low': 'LOW',
      'gemini-3.8-flash-low': 'LOW',
      'gemini 3.7 flash (medium)': 'MEDIUM',
      'gemini 3.7 flash medium': 'MEDIUM',
      'gemini-3.7-flash-medium': 'MEDIUM',
      'gemini 3.7 flash (high)': 'HIGH',
      'gemini 3.7 flash high': 'HIGH',
      'gemini-3.7-flash-high': 'HIGH',
      'gemini 3.7 flash (low)': 'LOW',
      'gemini 3.7 flash low': 'LOW',
      'gemini-3.7-flash-low': 'LOW',
    };
    const thinkingLevel = thinkingLevels[key];
    return {
      model: aliases[key] || normalized,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  }

  function codeAssistGenerateRequest(prepared, geminiBody, targetModel, stream) {
    const selection = codeAssistModelSelection(targetModel);
    const backendModel = selection.model;
    const sourceSelection = codeAssistModelSelection(prepared && prepared.model);
    const thinkingLevel =
      sourceSelection.model === backendModel
        ? sourceSelection.thinkingLevel
        : selection.thinkingLevel;
    const project =
      prepared.googleOfficialProjectId ||
      (prepared.profile && prepared.profile.googleOfficialProjectId) ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GOOGLE_CLOUD_PROJECT_ID ||
      undefined;
    let generationConfig = geminiBody.generationConfig;
    if (thinkingLevel && !(generationConfig && generationConfig.thinkingConfig)) {
      generationConfig = {
        ...(generationConfig || {}),
        thinkingConfig: { thinkingLevel },
      };
    }
    let tools = geminiBody.tools;
    let toolConfig = geminiBody.toolConfig || geminiBody.tool_config;
    const hasGoogleSearch = Array.isArray(tools) && tools.some((t) => t && t.googleSearch);
    const hasFunctions =
      Array.isArray(tools) &&
      tools.some(
        (t) => t && Array.isArray(t.functionDeclarations) && t.functionDeclarations.length > 0
      );

    // Code Assist upstream (daily-cloudcode-pa.googleapis.com) does not support
    // combining built-in Google Search grounding with custom function declarations
    // (it rejects with 400: "Please enable tool_config.include_server_side_tool_invocations to use Built-in tools with Function calling").
    // When both are present, prioritize custom functions (e.g. Codex tool use) and drop googleSearch.
    if (hasGoogleSearch && hasFunctions) {
      tools = tools
        .map((t) => {
          if (!t) return t;
          if (t.googleSearch) {
            const copy = { ...t };
            delete copy.googleSearch;
            return Object.keys(copy).length > 0 ? copy : null;
          }
          return t;
        })
        .filter(Boolean);
    } else if (
      toolConfig &&
      (toolConfig.includeServerSideToolInvocations ||
        toolConfig.include_server_side_tool_invocations)
    ) {
      toolConfig = {
        ...(toolConfig || {}),
        includeServerSideToolInvocations: true,
        include_server_side_tool_invocations: true,
      };
    }
    const request = {
      contents: geminiBody.contents,
      systemInstruction: geminiBody.systemInstruction,
      tools,
      toolConfig,
      tool_config: toolConfig,
      generationConfig,
    };
    for (const key of Object.keys(request)) {
      if (request[key] == null) delete request[key];
    }
    return {
      target: codeAssistUrl(stream ? 'streamGenerateContent' : 'generateContent', stream),
      body: {
        model: backendModel,
        project,
        user_prompt_id: fallbackId('proxy_prompt', {
          model: backendModel,
          project,
          route: prepared.model,
          request,
        }),
        request,
      },
    };
  }

  function unwrapCodeAssistResponse(payload) {
    return payload && payload.response ? payload.response : payload;
  }

  function unwrapCodeAssistSseEvent(event) {
    return String(event || '')
      .split(/\r?\n/)
      .map((line) => {
        if (!line.startsWith('data:')) return line;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return line;
        try {
          return 'data: ' + JSON.stringify(unwrapCodeAssistResponse(JSON.parse(data)));
        } catch (err) {
          return line;
        }
      })
      .join('\n');
  }

  return {
    shouldUseCodeAssistUpstream,
    codeAssistUrl,
    codeAssistUserAgent,
    codeAssistModelSelection,
    codeAssistGenerateRequest,
    unwrapCodeAssistResponse,
    unwrapCodeAssistSseEvent,
  };
}

module.exports = { createCodeAssist };
