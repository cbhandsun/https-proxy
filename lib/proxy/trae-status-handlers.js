const fs = require('fs');
const {
  getTraeStateDbPath,
  getTraeOfficialBridgeUrl,
  loadTraeSqlite3,
  getTraeSqlite3LoadError,
  readTraeStorageSummary,
  readTraeProductInfo,
  queryTraeStateRows,
  buildTraeOfficialModelsResponseFromRows,
} = require('./trae-official');

const {
  collectLogEvents,
  fetchBridgeRawEvents,
  currentTraeDebugSettings,
  getNativeDeepEvents,
  nativeDebugStatus,
  runNativeScan,
  startNativeDeepProbe,
  stopNativeDeepProbe,
  updateTraeDebugSettings,
} = require('./trae-debug-center');
const { parseBoundedInteger, readJsonBodyFromRequest } = require('./management-utils');

function sendJson(clientRes, statusCode, payload) {
  clientRes.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  clientRes.end(JSON.stringify(payload));
}

function isLoopbackHost(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
}

function createTraeStatusHandlers({
  makeRequest,
  makeClaudeSelfTestRequest,
  getClaudeMessagesBaseUrl,
  getClaudeSelfTestTarget,
} = {}) {
  async function handleLocalTraeStatusRequest(clientReq, clientRes) {
    try {
      const storage = readTraeStorageSummary();
      const product = readTraeProductInfo();
      const state = await queryTraeStateRows();
      const models = state.ok
        ? buildTraeOfficialModelsResponseFromRows(state.rows)
        : { models: [], rawModelCount: 0 };
      sendJson(clientRes, 200, {
        ok: true,
        exists: storage.exists || fs.existsSync(getTraeStateDbPath()) || product.exists,
        authMode: 'official-login',
        hasOfficialAuth: storage.hasOfficialAuth,
        authKeys: storage.authKeys,
        storagePath: storage.storagePath,
        stateDbPath: state.dbPath || getTraeStateDbPath(),
        stateDbExists: fs.existsSync(getTraeStateDbPath()),
        sqliteAvailable: Boolean(loadTraeSqlite3()),
        sqliteError: getTraeSqlite3LoadError(),
        modelCount: models.models.length,
        rawModelCount: models.rawModelCount,
        models: models.models,
        product,
      });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  async function handleLocalTraeBridgeStatusRequest(clientReq, clientRes) {
    const bridgeUrl = getTraeOfficialBridgeUrl('/health');
    try {
      const res = await makeRequest(bridgeUrl, { method: 'GET', timeout: 1500 }, null);
      let payload = {};
      try {
        payload = JSON.parse(res.body || '{}');
      } catch (err) {
        payload = { raw: res.body || '' };
      }
      sendJson(clientRes, 200, {
        ok: res.statusCode >= 200 && res.statusCode < 300,
        bridgeUrl,
        statusCode: res.statusCode,
        ...payload,
      });
    } catch (err) {
      sendJson(clientRes, 200, {
        ok: false,
        bridgeUrl,
        error: err.message,
        hint: 'Trae bridge extension is not reachable. Reload Trae after installing https-proxy-manager-trae-bridge.',
      });
    }
  }

  async function handleLocalTraeDebugEventsRequest(clientReq, clientRes) {
    try {
      const url = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
      const limit = parseBoundedInteger(url.searchParams.get('limit'), 80, 1, 200);
      const raw = await fetchBridgeRawEvents(makeRequest, getTraeOfficialBridgeUrl, limit);
      const logs = collectLogEvents({ limit });
      const events = []
        .concat(logs || [])
        .concat(raw.events || [])
        .slice(-limit);
      sendJson(clientRes, 200, {
        ok: true,
        raw: {
          ok: raw.ok,
          bridgeUrl: raw.bridgeUrl,
          command: raw.command,
          rawEventCount: raw.rawEventCount || 0,
          error: raw.error,
        },
        logEventCount: logs.length,
        events,
      });
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  function handleLocalTraeDebugNativeStatusRequest(clientReq, clientRes) {
    try {
      sendJson(clientRes, 200, nativeDebugStatus());
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  function handleLocalTraeDebugSettingsRequest(clientReq, clientRes) {
    try {
      sendJson(clientRes, 200, currentTraeDebugSettings());
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  function handleLocalTraeDebugSettingsSaveRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, (err, body) => {
      if (err) {
        sendJson(clientRes, 400, { ok: false, error: err.message });
        return;
      }
      try {
        sendJson(clientRes, 200, updateTraeDebugSettings(body));
      } catch (err) {
        sendJson(clientRes, 400, { ok: false, error: err.message });
      }
    });
  }

  function parseSseSummary(text) {
    const value = String(text || '');
    const messageStartMatch = value.match(/event:\s*message_start\s+data:\s*(\{[^\r\n]+\})/);
    let messageStartContentEmpty = false;
    if (messageStartMatch) {
      try {
        const parsed = JSON.parse(messageStartMatch[1]);
        messageStartContentEmpty =
          Array.isArray(parsed.message && parsed.message.content) &&
          parsed.message.content.length === 0;
      } catch (err) {}
    }
    return {
      messageStartContentEmpty,
      thinkingDeltaCount: (value.match(/"thinking_delta"/g) || []).length,
      signatureDeltaCount: (value.match(/"signature_delta"/g) || []).length,
      textDeltaCount: (value.match(/"text_delta"/g) || []).length,
      hasThinkingBlock: value.includes('"content_block":{"type":"thinking"'),
      hasTraeProcessText: value.includes('[Trae '),
      hasTraePlanItem: value.includes('[Trae plan_item'),
      hasTraeTiming: value.includes('[Trae timing'),
      hasDone: value.includes('event: message_stop'),
      firstProcessOffset: value.indexOf('[Trae '),
      lastTextDeltaOffset: value.lastIndexOf('"text_delta"'),
    };
  }

  function handleLocalTraeDebugClaudeProcessSelfTestRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, async (err, body) => {
      if (err) {
        sendJson(clientRes, 400, { ok: false, error: err.message });
        return;
      }
      const settings = currentTraeDebugSettings();
      const target =
        body && body.useClaudeDesktopGateway === false
          ? null
          : typeof getClaudeSelfTestTarget === 'function'
            ? getClaudeSelfTestTarget(body || {})
            : null;
      const baseUrl =
        typeof getClaudeMessagesBaseUrl === 'function'
          ? getClaudeMessagesBaseUrl()
          : 'https://localhost:3443/v1';
      const endpoint =
        target && target.endpoint
          ? String(target.endpoint)
          : String(baseUrl || 'https://localhost:3443/v1').replace(/\/$/, '') + '/messages';
      const payload = {
        model:
          target && target.model
            ? String(target.model)
            : body && body.model
              ? String(body.model)
              : 'trae/minimax-m3',
        stream: true,
        max_tokens: parseBoundedInteger(body && body.max_tokens, 300, 32, 2000),
        messages: [
          {
            role: 'user',
            content: body && body.prompt ? String(body.prompt) : '请只回复 OK。',
          },
        ],
      };
      try {
        let requester = makeRequest;
        try {
          const parsedEndpoint = new URL(endpoint);
          if (
            isLoopbackHost(parsedEndpoint.hostname) &&
            typeof makeClaudeSelfTestRequest === 'function'
          ) {
            requester = makeClaudeSelfTestRequest;
          }
        } catch (err) {}
        const response = await requester(
          endpoint,
          {
            method: 'POST',
            timeout: parseBoundedInteger(body && body.timeoutMs, 90000, 15000, 180000),
            headers: {
              Authorization: 'Bearer local-trae-debug-self-test',
              'Content-Type': 'application/json',
              ...(target && target.headers ? target.headers : {}),
            },
          },
          JSON.stringify(payload)
        );
        const summary = parseSseSummary(response.body || '');
        const style =
          target && typeof target.expectedStyle === 'string'
            ? target.expectedStyle
            : settings.claudeProcessStyle || '';
        const expectsThinking = style === 'thinking';
        const expectsText = style === 'text';
        const pass =
          response.statusCode >= 200 &&
          response.statusCode < 300 &&
          summary.hasTraeProcessText &&
          summary.hasDone &&
          (!expectsThinking || (summary.hasThinkingBlock && summary.thinkingDeltaCount > 0)) &&
          (!expectsText || (summary.thinkingDeltaCount === 0 && summary.textDeltaCount > 1));
        sendJson(clientRes, 200, {
          ok: true,
          pass,
          source: (target && target.source) || 'local-claude',
          expectedStyle: style,
          endpoint,
          statusCode: response.statusCode,
          settings,
          request: {
            model: payload.model,
            promptChars: payload.messages[0].content.length,
          },
          summary,
          hint: pass
            ? 'Claude process SSE is emitting Trae progress events.'
            : style
              ? 'Claude process SSE did not contain the expected Trae progress shape. Check the Desktop gateway route, token, and Trae process style.'
              : 'Claude process display is disabled for this target. Enable Trae process display and retry.',
        });
      } catch (testErr) {
        sendJson(clientRes, 502, {
          ok: false,
          pass: false,
          source: (target && target.source) || 'local-claude',
          expectedStyle:
            target && typeof target.expectedStyle === 'string'
              ? target.expectedStyle
              : settings.claudeProcessStyle || '',
          endpoint,
          settings,
          error: testErr.message || String(testErr),
        });
      }
    });
  }

  function handleLocalTraeDebugNativeScanRequest(clientReq, clientRes) {
    try {
      sendJson(clientRes, 200, runNativeScan());
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  function handleLocalTraeDebugNativeDeepEventsRequest(clientReq, clientRes) {
    try {
      const url = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
      const limit = parseBoundedInteger(url.searchParams.get('limit'), 80, 0, 240);
      sendJson(clientRes, 200, getNativeDeepEvents({ limit }));
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  function handleLocalTraeDebugNativeDeepStartRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, (err, body) => {
      if (err) {
        sendJson(clientRes, 400, { ok: false, error: err.message });
        return;
      }
      try {
        const result = startNativeDeepProbe(body || {});
        sendJson(clientRes, result && result.ok === false ? 400 : 200, result);
      } catch (startErr) {
        sendJson(clientRes, 500, { ok: false, error: startErr.message });
      }
    });
  }

  function handleLocalTraeDebugNativeDeepStopRequest(clientReq, clientRes) {
    try {
      sendJson(clientRes, 200, stopNativeDeepProbe());
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  return {
    handleLocalTraeStatusRequest,
    handleLocalTraeBridgeStatusRequest,
    handleLocalTraeDebugEventsRequest,
    handleLocalTraeDebugSettingsRequest,
    handleLocalTraeDebugSettingsSaveRequest,
    handleLocalTraeDebugClaudeProcessSelfTestRequest,
    handleLocalTraeDebugNativeStatusRequest,
    handleLocalTraeDebugNativeScanRequest,
    handleLocalTraeDebugNativeDeepEventsRequest,
    handleLocalTraeDebugNativeDeepStartRequest,
    handleLocalTraeDebugNativeDeepStopRequest,
  };
}

module.exports = {
  createTraeStatusHandlers,
};
