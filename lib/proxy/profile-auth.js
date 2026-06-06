const {
  buildGoogleOfficialLoadCodeAssistRequest,
  isGoogleOfficialLoginToken,
} = require('./google-official');

function joinUrlPath(baseUrl, extraPath) {
  let urlStr = baseUrl.trim();
  if (urlStr.endsWith('/')) {
    urlStr = urlStr.slice(0, -1);
  }
  if (extraPath.startsWith('/')) {
    return urlStr + extraPath;
  }
  return urlStr + '/' + extraPath;
}

function buildProfileAuthProbeRequest(protocol, targetUrl, apiKey, testModel = null, authMode = 'api-key') {
  if (protocol === 'openai') {
    let fullUrl;
    let method = 'GET';
    let requestBody = null;
    const headers = {
      'accept': 'application/json',
      'user-agent': 'Mozilla/5.0'
    };
    if (apiKey) {
      headers['authorization'] = `Bearer ${apiKey}`;
    }

    if (authMode === 'official-login' && targetUrl.includes('/backend-api')) {
      const baseUrl = targetUrl.split('/backend-api')[0];
      fullUrl = baseUrl + '/backend-api/models';
    } else if (testModel) {
      fullUrl = joinUrlPath(targetUrl, 'chat/completions');
      method = 'POST';
      headers['content-type'] = 'application/json';
      requestBody = JSON.stringify({
        model: testModel,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1
      });
    } else {
      if (targetUrl.includes('/backend-api')) {
        const baseUrl = targetUrl.split('/backend-api')[0];
        fullUrl = baseUrl + '/backend-api/models';
      } else {
        fullUrl = joinUrlPath(targetUrl, 'models');
      }
    }
    return { protocol, fullUrl, method, headers, requestBody };
  }

  if (protocol === 'gemini') {
    let fullUrl;
    let method = 'GET';
    let requestBody = null;
    const headers = {
      'accept': 'application/json',
      'user-agent': 'Mozilla/5.0'
    };

    if (authMode === 'official-login' && apiKey && isGoogleOfficialLoginToken(apiKey)) {
      return buildGoogleOfficialLoadCodeAssistRequest(apiKey);
    }

    if (testModel) {
      const actualModel = testModel.replace(/^models\//, '');
      fullUrl = joinUrlPath(targetUrl, `v1beta/models/${actualModel}:generateContent`);
      if (apiKey && isGoogleOfficialLoginToken(apiKey)) {
        headers['authorization'] = `Bearer ${apiKey}`;
      } else if (apiKey) {
        fullUrl += `?key=${encodeURIComponent(apiKey)}`;
      }
      method = 'POST';
      headers['content-type'] = 'application/json';
      requestBody = JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
      });
    } else {
      const extra = targetUrl.includes('/v1') ? 'models' : 'v1/models';
      fullUrl = joinUrlPath(targetUrl, extra);
      if (apiKey && isGoogleOfficialLoginToken(apiKey)) {
        headers['authorization'] = `Bearer ${apiKey}`;
      } else if (apiKey) {
        fullUrl += `?key=${encodeURIComponent(apiKey)}`;
      }
    }
    return { protocol, fullUrl, method, headers, requestBody };
  }

  if (protocol === 'claude') {
    const extra = targetUrl.includes('/v1') ? 'messages' : 'v1/messages';
    const fullUrl = joinUrlPath(targetUrl, extra);
    const headers = {
      'accept': 'application/json',
      'content-type': 'application/json',
      'x-api-key': apiKey || '',
      'anthropic-version': '2023-06-01',
      'user-agent': 'Mozilla/5.0'
    };
    const requestBody = JSON.stringify({
      model: testModel || 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1
    });
    return { protocol, fullUrl, method: 'POST', headers, requestBody };
  }

  return { protocol, unsupported: true };
}

function isSuccessfulResponse(res) {
  return res.statusCode >= 200 && res.statusCode < 300;
}

function truncateProfileAuthError(errorMsg) {
  if (typeof errorMsg === 'string' && errorMsg.length > 300) {
    return errorMsg.substring(0, 300) + '... (已截断)';
  }
  return errorMsg;
}

function responseLooksLikeHtml(res, errorMsg) {
  const contentType = res.headers && res.headers['content-type'];
  return typeof errorMsg === 'string' && (
    errorMsg.includes('<html') ||
    errorMsg.includes('<svg') ||
    (contentType && contentType.includes('text/html'))
  );
}

function extractOpenAIProfileAuthError(body) {
  let errorMsg = body;
  try {
    const parsed = JSON.parse(body);
    if (parsed && parsed.error) {
      if (typeof parsed.error === 'string') {
        errorMsg = parsed.error;
      } else if (parsed.error.message) {
        errorMsg = parsed.error.message;
      }
    }
  } catch (e) {}
  return errorMsg;
}

function extractGeminiProfileAuthError(body) {
  let errorMsg = body;
  try {
    const parsed = JSON.parse(body);
    if (parsed && parsed.error && parsed.error.message) {
      errorMsg = parsed.error.message;
    } else if (Array.isArray(parsed) && parsed[0] && parsed[0].error && parsed[0].error.message) {
      errorMsg = parsed[0].error.message;
    }
  } catch (e) {}
  return errorMsg;
}

function openAIBackendModelFound(body, testModel) {
  if (!testModel) return false;
  try {
    const parsed = JSON.parse(body);
    const models = Array.isArray(parsed.models) ? parsed.models : [];
    return models.some(model => {
      const id = typeof model === 'string' ? model : (model.slug || model.id || model.name || '');
      return id === testModel;
    });
  } catch (e) {}
  return false;
}

function evaluateOpenAIProfileAuthResponse(res, { testModel = null, authMode = 'api-key' } = {}) {
  if (isSuccessfulResponse(res)) {
    if (authMode === 'official-login') {
      const modelFound = openAIBackendModelFound(res.body, testModel);
      return {
        ok: true,
        authMode,
        message: testModel
          ? (modelFound ? `官方登录凭证有效，模型 ${testModel} 已在后台列表中。` : `官方登录凭证有效；后台列表未返回 ${testModel}，请以实际对话为准。`)
          : '官方登录凭证有效。'
      };
    }
    return { ok: true, message: testModel ? `模型 ${testModel} 测试成功` : undefined };
  }

  let errorMsg = extractOpenAIProfileAuthError(res.body);

  if (res.statusCode === 403 && typeof errorMsg === 'string' && (errorMsg.includes('Missing scopes') || errorMsg.includes('insufficient permissions'))) {
    return { ok: true, authMode, message: '凭证有效 (受限权限/只读权限)' };
  }

  if (authMode === 'official-login' && res.statusCode === 403) {
    return {
      ok: true,
      authMode,
      warning: '官方后台接口返回 403，通常是网络或 Cloudflare 阻断；已检测到官方登录凭证。',
      message: '已检测到官方登录凭证；后台探测被网络侧拦截。'
    };
  }

  if (responseLooksLikeHtml(res, errorMsg)) {
    if (authMode === 'official-login') {
      return {
        ok: true,
        authMode,
        warning: `官方后台返回 HTTP ${res.statusCode} HTML 响应，通常是网络侧拦截；已检测到官方登录凭证。`,
        message: '已检测到官方登录凭证；后台探测被网络侧拦截。'
      };
    }
    return { ok: false, error: `HTTP ${res.statusCode}: 请求被拦截，无法测试。` };
  }

  errorMsg = truncateProfileAuthError(errorMsg);
  return { ok: false, error: `HTTP ${res.statusCode}: ${errorMsg}` };
}

function evaluateGeminiProfileAuthResponse(res, { testModel = null, authMode = 'api-key', probeFullUrl = '' } = {}) {
  const isCodeAssistProbe = probeFullUrl.includes(':loadCodeAssist');
  if (isSuccessfulResponse(res)) {
    if (authMode === 'official-login' && isCodeAssistProbe) {
      return {
        ok: true,
        authMode,
        source: 'code-assist',
        message: 'Google 官方登录凭证有效，Code Assist/Antigravity 后端可达。'
      };
    }
    return { ok: true, message: testModel ? `模型 ${testModel} 测试成功` : undefined };
  }

  const errorMsg = extractGeminiProfileAuthError(res.body);
  if (authMode === 'official-login' && isCodeAssistProbe) {
    return {
      ok: false,
      authMode,
      source: 'code-assist',
      error: `Google 官方登录后端探测失败 HTTP ${res.statusCode}: ${errorMsg}`
    };
  }
  return { ok: false, error: `HTTP ${res.statusCode}: ${errorMsg}` };
}

function evaluateClaudeProfileAuthResponse(res, { testModel = null } = {}) {
  if (isSuccessfulResponse(res)) {
    return { ok: true, message: testModel ? `模型 ${testModel} 测试成功` : undefined };
  }

  let errorMsg = res.body;
  try {
    const parsed = JSON.parse(res.body);
    if (parsed && parsed.error && parsed.error.message) {
      errorMsg = parsed.error.message;
    }
  } catch (e) {}
  return { ok: false, error: `HTTP ${res.statusCode}: ${errorMsg}` };
}

module.exports = {
  joinUrlPath,
  buildProfileAuthProbeRequest,
  evaluateOpenAIProfileAuthResponse,
  evaluateGeminiProfileAuthResponse,
  evaluateClaudeProfileAuthResponse,
};
