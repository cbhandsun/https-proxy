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
  nativeDebugStatus,
  runNativeScan,
  updateTraeDebugSettings,
} = require('./trae-debug-center');

function sendJson(clientRes, statusCode, payload) {
  clientRes.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*'
  });
  clientRes.end(JSON.stringify(payload));
}

function createTraeStatusHandlers({ makeRequest }) {
  async function handleLocalTraeStatusRequest(clientReq, clientRes) {
    try {
      const storage = readTraeStorageSummary();
      const product = readTraeProductInfo();
      const state = await queryTraeStateRows();
      const models = state.ok ? buildTraeOfficialModelsResponseFromRows(state.rows) : { models: [], rawModelCount: 0 };
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
        product
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
        ...payload
      });
    } catch (err) {
      sendJson(clientRes, 200, {
        ok: false,
        bridgeUrl,
        error: err.message,
        hint: 'Trae bridge extension is not reachable. Reload Trae after installing https-proxy-manager-trae-bridge.'
      });
    }
  }

  async function handleLocalTraeDebugEventsRequest(clientReq, clientRes) {
    try {
      const url = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 80), 200));
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
    const chunks = [];
    clientReq.on('data', (chunk) => chunks.push(chunk));
    clientReq.on('end', () => {
      try {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const body = bodyText ? JSON.parse(bodyText) : {};
        sendJson(clientRes, 200, updateTraeDebugSettings(body));
      } catch (err) {
        sendJson(clientRes, 400, { ok: false, error: err.message });
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

  return {
    handleLocalTraeStatusRequest,
    handleLocalTraeBridgeStatusRequest,
    handleLocalTraeDebugEventsRequest,
    handleLocalTraeDebugSettingsRequest,
    handleLocalTraeDebugSettingsSaveRequest,
    handleLocalTraeDebugNativeStatusRequest,
    handleLocalTraeDebugNativeScanRequest,
  };
}

module.exports = {
  createTraeStatusHandlers,
};
