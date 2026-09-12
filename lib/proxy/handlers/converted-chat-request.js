'use strict';

const { buildWorkBuddyDesktopHeaders } = require('../workbuddy-official');

function createConvertedChatRequest(prepared, target, apiKey, requestBody) {
  if (!Buffer.isBuffer(requestBody)) throw new TypeError('requestBody must be a Buffer');
  const profile = (prepared && prepared.profile) || {};
  const headers = {
    'content-type': 'application/json',
    'content-length': requestBody.length,
  };
  if (apiKey) headers.authorization = 'Bearer ' + apiKey;

  const effectiveUid =
    (prepared && prepared.workbuddyAuth && prepared.workbuddyAuth.uid) || profile.uid;
  if (effectiveUid && (prepared.authProvider === 'workbuddy' || profile.protocol === 'workbuddy')) {
    Object.assign(headers, buildWorkBuddyDesktopHeaders({ uid: effectiveUid }));
  }

  const auditHeaders = {
    'content-type': headers['content-type'],
    'content-length': headers['content-length'],
  };
  if (headers.authorization) auditHeaders.authorization = '[redacted]';
  if (headers['x-user-id']) auditHeaders['x-user-id'] = '[redacted]';

  return {
    headers,
    audit: {
      method: 'POST',
      path: target.path + '/chat/completions',
      targetHost: target.hostname,
      targetProtocol: target.protocol,
      headers: auditHeaders,
      body: '',
      bodyBytes: requestBody.length,
    },
  };
}

module.exports = { createConvertedChatRequest };
