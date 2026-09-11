const os = require('os');
const path = require('path');
const { createAntigravityCredentialReader } = require('./antigravity-credentials');

const GOOGLE_OFFICIAL_CODE_ASSIST_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com';
const GOOGLE_OFFICIAL_CODE_ASSIST_API_VERSION = 'v1internal';
const GOOGLE_OFFICIAL_CODE_ASSIST_USER_AGENT = 'antigravity-cli/diagnostic';
const GOOGLE_OFFICIAL_AUDIO_TRANSCRIPTION_MODEL_ID = 'models/proactive-observer-v10';
const GOOGLE_OFFICIAL_AUDIO_TRANSCRIPTION_MODEL_NAME = 'Gemini 3.5 Transcribe';
const GOOGLE_OFFICIAL_AUDIO_TRANSCRIPTION_MODEL_SLUG = 'gemini-3.5-transcribe';
const GOOGLE_OFFICIAL_IMAGE_GENERATION_MODEL_ID = 'gemini-3.1-flash-image';
const GOOGLE_OFFICIAL_IMAGE_GENERATION_MODEL_NAME = 'Gemini 3.1 Flash Image';
const ANTIGRAVITY_OAUTH_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_OAUTH_CLIENT_SECRET = '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';
const GOOGLE_OFFICIAL_MODEL_IDS = [
  'Gemini 3.8 Flash',
  'Gemini 3.8 Flash Low',
  'Gemini 3.8 Flash Medium',
  'Gemini 3.8 Flash High',
  'gemini-3.8-flash',
  'gemini-3.8-flash-tiered',
  'gemini-3.8-flash-low',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-high',
  'Gemini 3.7 Flash',
  'Gemini 3.7 Flash Low',
  'Gemini 3.7 Flash Medium',
  'Gemini 3.7 Flash High',
  'gemini-3.7-flash',
  'gemini-3.7-flash-low',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-high',
  'gemini-3.7-flash-tiered',
  'Gemini 3.6 Flash (Medium)',
  'Gemini 3.6 Flash (High)',
  'Gemini 3.6 Flash (Low)',
  'gemini-3.6-flash',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-low',
  'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (High)',
  'Gemini 3.5 Flash (Low)',
  'gemini-3.5-flash',
  'gemini-3.5-flash-medium',
  'gemini-3.5-flash-high',
  'gemini-3.5-flash-low',
  'gemini-3.5-flash-extra-low',
  'gemini-3-flash-agent',
  'gemini-3-flash',
  'Gemini 3.1 Pro (Low)',
  'Gemini 3.1 Pro (High)',
  'gemini',
  'gemini-3.1',
  'gemini-3.1-pro-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro',
  'gemini-pro-agent',
  'gemini-3.1-flash-lite',
  GOOGLE_OFFICIAL_IMAGE_GENERATION_MODEL_ID,
  GOOGLE_OFFICIAL_IMAGE_GENERATION_MODEL_NAME,
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  GOOGLE_OFFICIAL_AUDIO_TRANSCRIPTION_MODEL_NAME,
  GOOGLE_OFFICIAL_AUDIO_TRANSCRIPTION_MODEL_SLUG,
  'proactive-observer-v10',
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)',
  'GPT-OSS 120B (Medium)',
];

function googleOfficialCodeAssistUrl(method) {
  const base = (process.env.CODE_ASSIST_ENDPOINT || GOOGLE_OFFICIAL_CODE_ASSIST_BASE_URL).replace(
    /\/$/,
    ''
  );
  const version = process.env.CODE_ASSIST_API_VERSION || GOOGLE_OFFICIAL_CODE_ASSIST_API_VERSION;
  return `${base}/${version}:${method}`;
}

function isGoogleOfficialProfile(profileOrId) {
  if (!profileOrId) return false;
  const id = typeof profileOrId === 'string' ? profileOrId : profileOrId.id;
  return typeof id === 'string' && id.toLowerCase() === 'google-official';
}

function isGoogleOfficialLoginToken(value) {
  return typeof value === 'string' && value.startsWith('ya29.');
}

function buildGoogleOfficialModelsResponse() {
  return {
    ok: true,
    models: GOOGLE_OFFICIAL_MODEL_IDS.slice(),
    authMode: 'official-login',
    source: 'official-model-config',
  };
}

function normalizeGoogleOfficialModelName(name) {
  return String(name || '')
    .replace(/^models\//, '')
    .trim();
}

function uniqueModelNames(names) {
  const seen = new Set();
  const result = [];
  for (const name of names) {
    const normalized = normalizeGoogleOfficialModelName(name);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function googleOfficialAudioTranscriptionModelNames(payload) {
  const ids = payload && payload.audioTranscriptionModelIds;
  if (!Array.isArray(ids)) return [];
  const names = [];
  for (const value of ids.slice(0, 64)) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (!/^models\/[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)) continue;
    names.push(id);
    if (id.toLowerCase() === GOOGLE_OFFICIAL_AUDIO_TRANSCRIPTION_MODEL_ID) {
      names.push(
        GOOGLE_OFFICIAL_AUDIO_TRANSCRIPTION_MODEL_NAME,
        GOOGLE_OFFICIAL_AUDIO_TRANSCRIPTION_MODEL_SLUG
      );
    }
  }
  return names;
}

function googleOfficialImageGenerationModelNames(payload) {
  const ids = payload && payload.imageGenerationModelIds;
  if (!Array.isArray(ids)) return [];
  const names = [];
  for (const value of ids.slice(0, 64)) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(id) || id.includes('..')) continue;
    names.push(id);
    if (
      normalizeGoogleOfficialModelName(id).toLowerCase() ===
      GOOGLE_OFFICIAL_IMAGE_GENERATION_MODEL_ID
    ) {
      names.push(GOOGLE_OFFICIAL_IMAGE_GENERATION_MODEL_NAME);
    }
  }
  return names;
}

function googleOfficialModelsFromAvailableModels(payload) {
  const models =
    payload && payload.models && typeof payload.models === 'object' ? payload.models : {};
  const names = [
    ...googleOfficialAudioTranscriptionModelNames(payload),
    ...googleOfficialImageGenerationModelNames(payload),
  ];
  for (const [id, details] of Object.entries(models)) {
    const displayName = details && details.displayName;
    if (displayName) names.push(displayName);
    if (!displayName || /^gemini-|^gemma-|^tab_|^chat_/i.test(id)) {
      names.push(id);
    }
    if (id === 'gemini-3.8-flash-tiered') {
      names.push(
        'Gemini 3.8 Flash',
        'Gemini 3.8 Flash Low',
        'Gemini 3.8 Flash Medium',
        'Gemini 3.8 Flash High',
        'gemini-3.8-flash',
        'gemini-3.8-flash-low',
        'gemini-3.8-flash-medium',
        'gemini-3.8-flash-high'
      );
    }
    if (id === 'gemini-3.7-flash-tiered') {
      names.push(
        'Gemini 3.7 Flash',
        'Gemini 3.7 Flash Low',
        'Gemini 3.7 Flash Medium',
        'Gemini 3.7 Flash High',
        'gemini-3.7-flash',
        'gemini-3.7-flash-low',
        'gemini-3.7-flash-medium',
        'gemini-3.7-flash-high'
      );
    }
  }
  return uniqueModelNames(names.length > 0 ? names : GOOGLE_OFFICIAL_MODEL_IDS);
}

function buildGoogleOfficialLoadCodeAssistRequest(apiKey, projectId) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': GOOGLE_OFFICIAL_CODE_ASSIST_USER_AGENT,
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const requestBody = JSON.stringify({
    cloudaicompanionProject:
      projectId ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GOOGLE_CLOUD_PROJECT_ID ||
      undefined,
    metadata: {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
      duetProject:
        projectId ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GOOGLE_CLOUD_PROJECT_ID ||
        undefined,
    },
    mode: 'HEALTH_CHECK',
  });
  return {
    protocol: 'gemini',
    fullUrl: googleOfficialCodeAssistUrl('loadCodeAssist'),
    method: 'POST',
    headers,
    requestBody,
  };
}

function buildGoogleOfficialAvailableModelsRequest(apiKey, projectId) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'antigravity',
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return {
    protocol: 'gemini',
    fullUrl: googleOfficialCodeAssistUrl('fetchAvailableModels'),
    method: 'POST',
    headers,
    requestBody: JSON.stringify({
      project:
        projectId ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GOOGLE_CLOUD_PROJECT_ID ||
        undefined,
    }),
  };
}

function buildGoogleOfficialRetrieveUserQuotaRequest(apiKey, projectId) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'antigravity',
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return {
    protocol: 'gemini',
    fullUrl: googleOfficialCodeAssistUrl('retrieveUserQuota'),
    method: 'POST',
    headers,
    requestBody: JSON.stringify({
      project:
        projectId ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GOOGLE_CLOUD_PROJECT_ID ||
        undefined,
      userAgent: 'antigravity',
    }),
  };
}

function resetTimeToDisplay(resetTime) {
  if (!resetTime) return '';
  const resetMs = Date.parse(resetTime);
  if (!Number.isFinite(resetMs)) return String(resetTime);
  const diffSec = Math.max(0, Math.round((resetMs - Date.now()) / 1000));
  if (diffSec < 3600) return Math.ceil(diffSec / 60) + 'm';
  if (diffSec < 86400) {
    const h = Math.floor(diffSec / 3600);
    const m = Math.ceil((diffSec % 3600) / 60);
    return `${h}h${m}m`;
  }
  const d = Math.floor(diffSec / 86400);
  const h = Math.ceil((diffSec % 86400) / 3600);
  return `${d}d${h}h`;
}

function formatGoogleOfficialAvailableModels(data) {
  const modelsObj = data && data.models && typeof data.models === 'object' ? data.models : null;
  if (!modelsObj) return [];
  const preferredByName = new Map();
  const formatted = Object.entries(modelsObj)
    .filter(([modelId]) => {
      return !/^chat_/i.test(modelId) && !/^tab_/i.test(modelId);
    })
    .map(([modelId, item]) => {
      const quota = item && item.quotaInfo ? item.quotaInfo : {};
      const remainingFraction =
        typeof quota.remainingFraction === 'number' ? quota.remainingFraction : null;
      const remainingPercent =
        remainingFraction === null
          ? null
          : Math.max(0, Math.min(100, Math.round(remainingFraction * 100)));
      return {
        model: item && item.displayName ? item.displayName : modelId,
        modelId,
        percent: remainingPercent === null ? 0 : remainingPercent,
        remainingPercent,
        resetIn: resetTimeToDisplay(quota.resetTime),
        resetTime: quota.resetTime || '',
      };
    });

  for (const item of formatted) {
    const key = String(item.model || item.modelId).toLowerCase();
    const existing = preferredByName.get(key);
    if (!existing) {
      preferredByName.set(key, item);
      continue;
    }
    const itemScore =
      Number(item.modelId === key) +
      Number(item.modelId.includes('3.1')) +
      Number(item.modelId.includes('3.5'));
    const existingScore =
      Number(existing.modelId === key) +
      Number(existing.modelId.includes('3.1')) +
      Number(existing.modelId.includes('3.5'));
    if (itemScore > existingScore) preferredByName.set(key, item);
  }

  return Array.from(preferredByName.values()).sort((a, b) => {
    const ar = a.remainingPercent === null ? -1 : a.remainingPercent;
    const br = b.remainingPercent === null ? -1 : b.remainingPercent;
    if (br !== ar) return br - ar;
    return String(a.model).localeCompare(String(b.model));
  });
}

function formatGoogleOfficialUserQuota(data) {
  const buckets = data && Array.isArray(data.buckets) ? data.buckets : [];
  return buckets.map((bucket) => {
    const remainingFraction =
      typeof bucket.remainingFraction === 'number' ? bucket.remainingFraction : null;
    const remainingPercent =
      remainingFraction === null
        ? null
        : Math.max(0, Math.min(100, Math.round(remainingFraction * 100)));
    const model = bucket.modelId || bucket.tokenType || 'Quota';
    return {
      model,
      modelId: bucket.modelId || '',
      percent: remainingPercent === null ? 0 : remainingPercent,
      remainingPercent,
      remainingAmount: bucket.remainingAmount || '',
      resetIn: resetTimeToDisplay(bucket.resetTime),
      resetTime: bucket.resetTime || '',
    };
  });
}

function getGoogleOfficialCredentialPaths() {
  return [
    path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'oauth_creds.json'),
  ];
}

function antigravityStateDbPaths() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return [
    path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
    path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
  ];
}

function base64DecodeLoose(value) {
  const raw = String(value || '').trim();
  if (!raw) return Buffer.alloc(0);
  return Buffer.from(raw + '='.repeat((4 - (raw.length % 4)) % 4), 'base64');
}

function decodeAntigravityOAuthStateValue(value) {
  try {
    const outer = base64DecodeLoose(value).toString('latin1');
    const blobs = outer.match(/[A-Za-z0-9_-]{80,}/g) || [];
    for (const blob of blobs) {
      const inner = base64DecodeLoose(blob).toString('latin1');
      const access = inner.match(/ya29\.[A-Za-z0-9._-]+/);
      const refresh = inner.match(/1\/\/[A-Za-z0-9._-]+/);
      if (access || refresh) {
        return {
          access_token: access ? access[0] : '',
          refresh_token: refresh ? refresh[0] : '',
          token_type: 'Bearer',
          client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
          client_secret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
          expiry_date: refresh ? 1 : 0,
          __readOnly: true,
          __source: 'antigravity-state',
        };
      }
    }
  } catch (err) {}
  return null;
}

const readAntigravityOfficialCredentialState = createAntigravityCredentialReader({
  databasePaths: antigravityStateDbPaths,
  decode: decodeAntigravityOAuthStateValue,
});

function readGoogleOfficialCredentialFile() {
  // The official Gemini route uses Antigravity Code Assist. Gemini CLI OAuth
  // belongs to a different client and must never silently replace this login.
  return readAntigravityOfficialCredentialState();
}

module.exports = {
  GOOGLE_OFFICIAL_CODE_ASSIST_USER_AGENT,
  GOOGLE_OFFICIAL_AUDIO_TRANSCRIPTION_MODEL_ID,
  GOOGLE_OFFICIAL_AUDIO_TRANSCRIPTION_MODEL_NAME,
  GOOGLE_OFFICIAL_AUDIO_TRANSCRIPTION_MODEL_SLUG,
  GOOGLE_OFFICIAL_IMAGE_GENERATION_MODEL_ID,
  GOOGLE_OFFICIAL_IMAGE_GENERATION_MODEL_NAME,
  googleOfficialCodeAssistUrl,
  isGoogleOfficialProfile,
  isGoogleOfficialLoginToken,
  buildGoogleOfficialModelsResponse,
  googleOfficialAudioTranscriptionModelNames,
  googleOfficialImageGenerationModelNames,
  googleOfficialModelsFromAvailableModels,
  buildGoogleOfficialLoadCodeAssistRequest,
  buildGoogleOfficialAvailableModelsRequest,
  buildGoogleOfficialRetrieveUserQuotaRequest,
  resetTimeToDisplay,
  formatGoogleOfficialAvailableModels,
  formatGoogleOfficialUserQuota,
  getGoogleOfficialCredentialPaths,
  antigravityStateDbPaths,
  decodeAntigravityOAuthStateValue,
  readAntigravityOfficialCredentialState,
  readGoogleOfficialCredentialFile,
};
