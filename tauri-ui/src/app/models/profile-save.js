const MAX_ID_LENGTH = 200;
const MAX_NAME_LENGTH = 200;
const MAX_URL_LENGTH = 2048;
const MAX_PROTOCOL_LENGTH = 64;
const MAX_SECRET_LENGTH = 4096;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedString(value, fieldName, maxLength, options = {}) {
  if (typeof value !== 'string') throw new TypeError(`${fieldName} must be a string`);
  const normalized = value.trim();
  if (options.required === true && !normalized) throw new Error(`${fieldName} is required`);
  if (normalized.length > maxLength) throw new Error(`${fieldName} is too long`);
  return normalized;
}

function normalizeProfile(profile) {
  if (!isRecord(profile)) throw new TypeError('profile must be an object');
  return {
    id: normalizedString(profile.id, 'profile.id', MAX_ID_LENGTH, { required: true }),
    name: normalizedString(profile.name, 'profile.name', MAX_NAME_LENGTH),
    targetUrl: normalizedString(profile.targetUrl, 'profile.targetUrl', MAX_URL_LENGTH, {
      required: true,
    }),
    protocol: normalizedString(profile.protocol, 'profile.protocol', MAX_PROTOCOL_LENGTH),
    apiKey: normalizedString(profile.apiKey, 'profile.apiKey', MAX_SECRET_LENGTH),
    allowInsecureHttpUpstream: profile.allowInsecureHttpUpstream === true,
  };
}

export function buildProfileSaveCandidate(configuration, selectedId, profile) {
  if (!isRecord(configuration)) throw new TypeError('configuration must be an object');
  if (!Array.isArray(configuration.profiles)) {
    throw new TypeError('configuration.profiles must be an array');
  }

  const nextProfile = normalizeProfile(profile);
  const currentId = typeof selectedId === 'string' ? selectedId.trim().slice(0, MAX_ID_LENGTH) : '';
  const profiles = configuration.profiles.slice();
  const index = profiles.findIndex(
    (item) => isRecord(item) && (item.id === currentId || item.id === nextProfile.id)
  );
  if (index >= 0) profiles[index] = nextProfile;
  else profiles.push(nextProfile);

  return {
    configuration: { ...configuration, profiles },
    selectedId: nextProfile.id,
  };
}
