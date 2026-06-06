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

  return {
    handleLocalTraeStatusRequest,
    handleLocalTraeBridgeStatusRequest,
  };
}

module.exports = {
  createTraeStatusHandlers,
};
