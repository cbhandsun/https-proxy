const ENTRY_AUTH_HEADERS = ['authorization', 'api-key', 'x-api-key', 'proxy-authorization'];
const MAX_ENTRY_KEY_LENGTH = 4096;

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asTrimmedString(item)).filter(Boolean);
}

function normalizePortList(value) {
  if (!Array.isArray(value)) return [];
  const ports = [];
  for (const item of value) {
    const parsed = Number.parseInt(String(item), 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535) ports.push(parsed);
  }
  return ports;
}

function keyFromEnvironment(env) {
  const raw = asTrimmedString(env && env.PROXY_ENTRY_KEYS);
  if (!raw) return [];
  return raw
    .split(',')
    .map((key, index) => ({
      id: `env-${index + 1}`,
      name: `Environment key ${index + 1}`,
      key: key.trim(),
      enabled: true,
    }))
    .filter((item) => item.key);
}

function normalizeEntryKeyRecord(record, index) {
  if (!record || typeof record !== 'object') return null;
  const key = asTrimmedString(record.key);
  if (!key || key.length > MAX_ENTRY_KEY_LENGTH) return null;
  return {
    id: asTrimmedString(record.id) || `key-${index + 1}`,
    name: asTrimmedString(record.name) || `Entry key ${index + 1}`,
    key,
    enabled: record.enabled !== false,
    allowedEntryProtocols: normalizeStringList(record.allowedEntryProtocols).map((item) =>
      item.toLowerCase()
    ),
    allowedEntryPorts: normalizePortList(record.allowedEntryPorts),
    allowedProfileIds: normalizeStringList(record.allowedProfileIds),
  };
}

function normalizeEntryAuthConfig(config, env = process.env) {
  const configured =
    config && config.entryAuth && typeof config.entryAuth === 'object' ? config.entryAuth : {};
  const configKeys = Array.isArray(configured.keys) ? configured.keys : [];
  const envKeys = keyFromEnvironment(env);
  const keys = [...configKeys, ...envKeys]
    .map((record, index) => normalizeEntryKeyRecord(record, index))
    .filter(Boolean);
  const enabled = Boolean(configured.enabled) || envKeys.length > 0;
  return { enabled, keys };
}

function extractHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const value = headers[name];
  if (Array.isArray(value)) return asTrimmedString(value[0]);
  return asTrimmedString(value);
}

function extractEntryCredential(headers) {
  const authorization = extractHeader(headers, 'authorization');
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) return bearerMatch[1].trim();

  const proxyAuthorization = extractHeader(headers, 'proxy-authorization');
  const proxyBearerMatch = proxyAuthorization.match(/^Bearer\s+(.+)$/i);
  if (proxyBearerMatch) return proxyBearerMatch[1].trim();

  return extractHeader(headers, 'x-api-key') || extractHeader(headers, 'api-key');
}

function entryMatchesKey(entry, keyRecord) {
  if (!entry || !keyRecord) return false;
  const protocol = asTrimmedString(entry.protocol).toLowerCase();
  const port = Number.parseInt(String(entry.listenPort), 10);
  if (
    keyRecord.allowedEntryProtocols.length > 0 &&
    !keyRecord.allowedEntryProtocols.includes(protocol)
  ) {
    return false;
  }
  if (keyRecord.allowedEntryPorts.length > 0 && !keyRecord.allowedEntryPorts.includes(port)) {
    return false;
  }
  return true;
}

function profileMatchesEntryKey(entryAuth, profile) {
  const keyRecord = entryAuth && entryAuth.key;
  if (!keyRecord) return false;
  if (keyRecord.allowedProfileIds.length === 0) return true;
  const profileId = asTrimmedString(profile && profile.id);
  return Boolean(profileId && keyRecord.allowedProfileIds.includes(profileId));
}

function authorizeEntryRequest(req, entry, config, env = process.env) {
  const authConfig = normalizeEntryAuthConfig(config, env);
  if (!authConfig.enabled) return { ok: true, enabled: false };
  if (authConfig.keys.length === 0) {
    return { ok: false, enabled: true, status: 401, reason: 'no_keys_configured' };
  }

  const credential = extractEntryCredential(req && req.headers);
  if (!credential || credential.length > MAX_ENTRY_KEY_LENGTH) {
    return { ok: false, enabled: true, status: 401, reason: 'missing_or_invalid' };
  }

  const key = authConfig.keys.find(
    (item) => item.enabled && item.key === credential && entryMatchesKey(entry, item)
  );
  if (!key) return { ok: false, enabled: true, status: 401, reason: 'unauthorized' };
  return { ok: true, enabled: true, key: { ...key, key: undefined } };
}

function stripEntryAuthHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  for (const name of ENTRY_AUTH_HEADERS) {
    delete headers[name];
  }
  return headers;
}

module.exports = {
  ENTRY_AUTH_HEADERS,
  authorizeEntryRequest,
  extractEntryCredential,
  normalizeEntryAuthConfig,
  profileMatchesEntryKey,
  stripEntryAuthHeaders,
};
