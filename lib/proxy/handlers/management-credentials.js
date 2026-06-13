const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const { readAntigravityOfficialCredentialState } = require('../google-official');
const { refreshGoogleAccessToken } = require('../google-official-runtime');

function credentialTypeFromRequest(clientReq) {
  const parsedUrl = new URL(clientReq.url, 'http://localhost');
  return String(parsedUrl.searchParams.get('type') || '')
    .trim()
    .toLowerCase();
}

function createManagementCredentialsHandlers({
  sendJson,
  fsModule = fs,
  homeDir = os.homedir,
  readAntigravityState = readAntigravityOfficialCredentialState,
  refreshGoogleToken = refreshGoogleAccessToken,
} = {}) {
  if (typeof sendJson !== 'function') {
    throw new TypeError('createManagementCredentialsHandlers requires sendJson');
  }
  if (typeof homeDir !== 'function') {
    throw new TypeError('createManagementCredentialsHandlers requires homeDir');
  }

  function readJsonFileIfExists(filePath) {
    if (!fsModule.existsSync(filePath)) return null;
    return JSON.parse(fsModule.readFileSync(filePath, 'utf8'));
  }

  function sendGoogleCredentials(clientRes) {
    const credsPath = path.join(homeDir(), '.gemini', 'oauth_creds.json');
    const content = readJsonFileIfExists(credsPath);
    if (!content) return false;
    sendJson(clientRes, 200, {
      ok: true,
      token: content.access_token || '',
      expiry: content.expiry_date || 0,
      hasRefreshToken: !!content.refresh_token,
    });
    return true;
  }

  function sendCodexCredentials(clientRes) {
    const authPath = path.join(homeDir(), '.codex', 'auth.json');
    const content = readJsonFileIfExists(authPath);
    if (!content) return false;
    const token = (content.tokens && content.tokens.access_token) || content.OPENAI_API_KEY || '';
    sendJson(clientRes, 200, {
      ok: true,
      token,
      hasRefreshToken: !!(content.tokens && content.tokens.refresh_token),
    });
    return true;
  }

  function sendAntigravityCredentials(clientRes) {
    const agyCreds = readAntigravityState();
    if (!agyCreds || !agyCreds.content) return false;
    const finish = (token) => {
      sendJson(clientRes, 200, {
        ok: true,
        token: token || agyCreds.content.access_token || '',
        expiry: agyCreds.content.expiry_date || 0,
        hasRefreshToken: !!agyCreds.content.refresh_token,
        source: agyCreds.source,
      });
    };
    if (agyCreds.content.refresh_token) {
      refreshGoogleToken(null, agyCreds.content)
        .then(finish)
        .catch(() => finish(agyCreds.content.access_token || ''));
    } else {
      finish(agyCreds.content.access_token || '');
    }
    return true;
  }

  function handleLocalCliCredentialsRequest(clientReq, clientRes) {
    try {
      const type = credentialTypeFromRequest(clientReq);
      if (type === 'google' && sendGoogleCredentials(clientRes)) return;
      if ((type === 'antigravity' || type === 'agy') && sendAntigravityCredentials(clientRes)) {
        return;
      }
      if ((type === 'codex' || type === 'openai') && sendCodexCredentials(clientRes)) return;

      sendJson(clientRes, 404, { ok: false, error: '未找到本地凭据文件' });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  return {
    handleLocalCliCredentialsRequest,
  };
}

module.exports = {
  createManagementCredentialsHandlers,
  credentialTypeFromRequest,
};
