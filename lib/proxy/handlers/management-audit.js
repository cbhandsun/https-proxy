const { URL } = require('url');

const {
  getAuditRecords,
  clearAuditRecords,
  getAuditRecordById,
  getClientActivityRecords,
} = require('../audit');
const { parseBoundedInteger, readJsonBodyFromRequest } = require('../management-utils');
const {
  redactHeaders,
  headersForReplay,
  parseJsonText,
  buildUsageReport,
} = require('../usage-report');

function createManagementAuditHandlers({
  sendJson,
  makeRequest,
  currentConfigSnapshot,
  getLocalServerSnapshot,
  defaultPort,
} = {}) {
  if (typeof sendJson !== 'function') throw new Error('sendJson is required');
  if (typeof makeRequest !== 'function') throw new Error('makeRequest is required');
  if (typeof currentConfigSnapshot !== 'function') {
    throw new Error('currentConfigSnapshot is required');
  }
  if (typeof getLocalServerSnapshot !== 'function') {
    throw new Error('getLocalServerSnapshot is required');
  }

  function handleLocalAuditConversationsRequest(clientReq, clientRes) {
    try {
      const url = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
      const limit = parseBoundedInteger(url.searchParams.get('limit'), 50, 1, 1000);
      const records = getAuditRecords(limit);
      sendJson(clientRes, 200, { ok: true, conversations: records });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalClientActivityRequest(clientReq, clientRes) {
    try {
      const url = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
      const client = String(url.searchParams.get('client') || '')
        .trim()
        .toLowerCase();
      const limit = parseBoundedInteger(url.searchParams.get('limit'), 5, 1, 50);
      const records = getClientActivityRecords(client, limit);
      sendJson(clientRes, 200, { ok: true, client, activities: records });
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  async function handleLocalAuditConversationsClearRequest(clientReq, clientRes) {
    try {
      const ok = await clearAuditRecords();
      sendJson(clientRes, 200, { ok });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function localReplayBaseUrl(record) {
    const localServer = getLocalServerSnapshot();
    const tls = localServer && localServer.tls === false ? false : true;
    const port = parseBoundedInteger(record && record.entryPort, defaultPort, 1, 65535);
    return `${tls ? 'https' : 'http'}://127.0.0.1:${port}`;
  }

  function handleLocalAuditRetryRequest(clientReq, clientRes) {
    readJsonBodyFromRequest(clientReq, async (bodyErr, payload) => {
      if (bodyErr) {
        sendJson(clientRes, 400, { ok: false, error: bodyErr.message });
        return;
      }
      try {
        const record = getAuditRecordById(payload && payload.id);
        if (!record) {
          sendJson(clientRes, 404, { ok: false, error: '未找到对应审计记录' });
          return;
        }
        if (!record.request || !record.request.body || record.request.truncated) {
          sendJson(clientRes, 400, { ok: false, error: '该请求体为空或已截断，无法安全重试' });
          return;
        }

        const replayHeaders = headersForReplay(record.request.headers);
        replayHeaders['content-type'] =
          replayHeaders['content-type'] || replayHeaders['Content-Type'] || 'application/json';
        replayHeaders['x-hpm-retry-of'] = record.id;
        const replayBody = record.request.body;
        replayHeaders['content-length'] = Buffer.byteLength(replayBody);
        const replayUrl = localReplayBaseUrl(record) + record.path;
        const response = await makeRequest(
          replayUrl,
          {
            method: record.method || 'POST',
            headers: replayHeaders,
            timeout: parseBoundedInteger(payload && payload.timeout, 60000, 1000, 300000),
          },
          replayBody
        );
        const parsed = parseJsonText(response.body);
        sendJson(clientRes, 200, {
          ok: response.statusCode >= 200 && response.statusCode < 300,
          statusCode: response.statusCode,
          headers: redactHeaders(response.headers || {}),
          body: parsed || response.body,
          bodyText: parsed ? '' : response.body,
        });
      } catch (err) {
        sendJson(clientRes, 500, { ok: false, error: err.message });
      }
    });
  }

  function handleLocalUsageReportRequest(clientReq, clientRes) {
    try {
      const url = new URL(clientReq.url, `http://${clientReq.headers.host || 'localhost'}`);
      const limit = parseBoundedInteger(url.searchParams.get('limit'), 300, 1, 2000);
      const after = url.searchParams.get('after') || '';
      let records = getAuditRecords(limit);
      if (after) {
        const afterTime = Date.parse(after);
        if (Number.isFinite(afterTime)) {
          records = records.filter((record) => Date.parse(record.time || '') >= afterTime);
        }
      }
      const report = buildUsageReport(records, currentConfigSnapshot());
      sendJson(clientRes, 200, report);
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message });
    }
  }

  return {
    handleLocalAuditConversationsRequest,
    handleLocalClientActivityRequest,
    handleLocalAuditConversationsClearRequest,
    handleLocalAuditRetryRequest,
    handleLocalUsageReportRequest,
    localReplayBaseUrl,
  };
}

module.exports = {
  createManagementAuditHandlers,
};
