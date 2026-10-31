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

function normalizeProfile(profile, existingProfile = null) {
  if (!isRecord(profile)) throw new TypeError('profile must be an object');
  const id = normalizedString(profile.id, 'profile.id', MAX_ID_LENGTH, { required: true });
  const normalized = {
    id,
    name: normalizedString(profile.name, 'profile.name', MAX_NAME_LENGTH),
    targetUrl: normalizedString(profile.targetUrl, 'profile.targetUrl', MAX_URL_LENGTH, {
      required: true,
    }),
    protocol: normalizedString(profile.protocol, 'profile.protocol', MAX_PROTOCOL_LENGTH),
    apiKey: normalizedString(profile.apiKey, 'profile.apiKey', MAX_SECRET_LENGTH),
    allowInsecureHttpUpstream: profile.allowInsecureHttpUpstream === true,
  };

  const rawBackupId =
    profile.backupProfileId !== undefined
      ? profile.backupProfileId
      : isRecord(existingProfile)
        ? existingProfile.backupProfileId
        : '';
  if (typeof rawBackupId === 'string' && rawBackupId.trim()) {
    const backupId = normalizedString(rawBackupId, 'profile.backupProfileId', MAX_ID_LENGTH);
    if (backupId && backupId !== id) {
      normalized.backupProfileId = backupId;
    }
  }

  const rawFallbacks =
    profile.fallbackProfileIds !== undefined
      ? profile.fallbackProfileIds
      : isRecord(existingProfile)
        ? existingProfile.fallbackProfileIds
        : undefined;
  if (Array.isArray(rawFallbacks)) {
    const fallbackIds = Array.from(
      new Set(
        rawFallbacks
          .filter((item) => typeof item === 'string')
          .map((item) => item.trim().slice(0, MAX_ID_LENGTH))
          .filter((item) => item && item !== id)
      )
    ).slice(0, 8);
    if (fallbackIds.length > 0) {
      normalized.fallbackProfileIds = fallbackIds;
    }
  }

  const rawAllowPostFailover =
    typeof profile.allowPostFailover === 'boolean'
      ? profile.allowPostFailover
      : isRecord(existingProfile) && existingProfile.allowPostFailover === true;
  if (rawAllowPostFailover === true) {
    normalized.allowPostFailover = true;
  }

  const rawPromptMasking =
    profile.promptMasking !== undefined
      ? profile.promptMasking
      : isRecord(existingProfile)
        ? existingProfile.promptMasking
        : undefined;
  if (rawPromptMasking === true) {
    normalized.promptMasking = true;
  } else if (isRecord(rawPromptMasking) && rawPromptMasking.enabled === true) {
    normalized.promptMasking = {
      enabled: true,
      ...(rawPromptMasking.maskEmails === true ? { maskEmails: true } : {}),
      ...(rawPromptMasking.maskPrivateIps === true ? { maskPrivateIps: true } : {}),
    };
  }

  const rawMaskingKeywords =
    profile.promptMaskingKeywords !== undefined
      ? profile.promptMaskingKeywords
      : isRecord(existingProfile)
        ? existingProfile.promptMaskingKeywords
        : '';
  if (typeof rawMaskingKeywords === 'string' && rawMaskingKeywords.trim()) {
    normalized.promptMaskingKeywords = normalizedString(
      rawMaskingKeywords,
      'profile.promptMaskingKeywords',
      MAX_URL_LENGTH
    );
  }

  return normalized;
}

export function buildProfileSaveCandidate(configuration, selectedId, profile) {
  if (!isRecord(configuration)) throw new TypeError('configuration must be an object');
  if (!Array.isArray(configuration.profiles)) {
    throw new TypeError('configuration.profiles must be an array');
  }

  const currentId = typeof selectedId === 'string' ? selectedId.trim().slice(0, MAX_ID_LENGTH) : '';
  const profiles = configuration.profiles.slice();
  const candidateId =
    isRecord(profile) && typeof profile.id === 'string'
      ? profile.id.trim().slice(0, MAX_ID_LENGTH)
      : '';
  const index = profiles.findIndex(
    (item) => isRecord(item) && (item.id === currentId || item.id === candidateId)
  );
  const existingProfile = index >= 0 ? profiles[index] : null;
  const nextProfile = normalizeProfile(profile, existingProfile);
  if (index >= 0) profiles[index] = nextProfile;
  else profiles.push(nextProfile);

  return {
    configuration: { ...configuration, profiles },
    selectedId: nextProfile.id,
  };
}
