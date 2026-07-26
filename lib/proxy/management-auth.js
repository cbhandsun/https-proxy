'use strict';

const crypto = require('crypto');

const MAX_MANAGEMENT_TOKEN_BYTES = 4096;

function readManagementTokenHeader(req) {
  const value = req && req.headers ? req.headers['x-mgmt-token'] : '';
  if (Array.isArray(value) || value == null) return '';
  const token = String(value).trim();
  if (!token || Buffer.byteLength(token, 'utf8') > MAX_MANAGEMENT_TOKEN_BYTES) return '';
  return token;
}

function managementTokenMatches(expectedToken, providedToken) {
  const expected = String(expectedToken || '');
  const provided = String(providedToken || '');
  if (!expected || !provided) return false;

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (
    expectedBuffer.length === 0 ||
    expectedBuffer.length > MAX_MANAGEMENT_TOKEN_BYTES ||
    expectedBuffer.length !== providedBuffer.length
  ) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function authorizeManagementRequest(req, expectedToken) {
  return managementTokenMatches(expectedToken, readManagementTokenHeader(req));
}

module.exports = {
  MAX_MANAGEMENT_TOKEN_BYTES,
  authorizeManagementRequest,
  managementTokenMatches,
  readManagementTokenHeader,
};
