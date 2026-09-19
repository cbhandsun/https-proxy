const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLogger } = require('./logger');
const { AntigravityCredentialError } = require('./antigravity-credentials');
const { TIANXI_OFFICIAL_TARGET_URL } = require('./tianxi-official');

const safeLog = createLogger('auth-resolver');

function isReadOnlyAntigravityCredential(content) {
  return (
    content &&
    content.__readOnly === true &&
    typeof content.__source === 'string' &&
    content.__source.startsWith('antigravity-')
  );
}

function createAuthResolver(deps) {
  const {
    loadConfig,
    getProfiles,
    decryptKey,
    officialLoginProvider,
    inferOfficialProfileAuthMode,
    configuredAuthMode,
    isRedactedSecret,
    readGoogleOfficialCredentialFile,
    refreshGoogleAccessToken,
    getFreshAntigravityOfficialAccessToken,
    resolveGoogleOfficialLoginPrepared,
    shouldUseChatGPTBackendForOfficialLogin,
    TRAE_OFFICIAL_TARGET_URL,
    readTraeStorageSummary,
    isGoogleOfficialLoginToken,
    PROFILES,
  } = deps;

  function decryptProfileApiKey(profile) {
    let apiKey = profile && profile.apiKey;
    if (
      apiKey &&
      (apiKey.startsWith('hpm-enc:') ||
        apiKey.startsWith('hpm-dpapi:') ||
        apiKey.startsWith('hpm-aes-v2:'))
    ) {
      apiKey = decryptKey(apiKey);
    } else if (apiKey === '***' || apiKey === '[redacted]') {
      apiKey = '';
    }
    return apiKey;
  }

  function profilesSnapshot() {
    return typeof PROFILES === 'function' ? PROFILES() : PROFILES;
  }

  function resolveConfiguredProfile(inputProfile, lookupId) {
    const id = lookupId || (inputProfile && (inputProfile.profileId || inputProfile.id));
    let finalProfile = {
      ...(inputProfile || {}),
      id: id || (inputProfile && inputProfile.id),
      apiKey: decryptProfileApiKey(inputProfile || {}),
    };

    if (id) {
      const config = loadConfig();
      const profiles = getProfiles(config) || [];
      const found = profiles.find((p) => p && p.id === id);
      if (found) {
        finalProfile = {
          ...found,
          apiKey: decryptProfileApiKey(found),
        };
      }
    }

    return finalProfile;
  }

  function resolveOfficialCredentials(prepared, clientHeaders) {
    return new Promise((resolve, reject) => {
      const profile = prepared.profile;
      if (!profile) return resolve(prepared);

      const provider = officialLoginProvider(profile);
      const isOfficialProfile = Boolean(provider);
      const requestedAuthMode = isOfficialProfile
        ? inferOfficialProfileAuthMode(profile, provider)
        : configuredAuthMode(profile);

      if (!isOfficialProfile) {
        const clientAuth =
          clientHeaders &&
          (clientHeaders['authorization'] ||
            clientHeaders['x-api-key'] ||
            clientHeaders['x-goog-api-key'] ||
            clientHeaders['api-key']);
        if (
          clientAuth &&
          clientAuth !== 'Bearer PROXY_MANAGED' &&
          clientAuth !== 'PROXY_MANAGED' &&
          !clientAuth.includes('***') &&
          !clientAuth.includes('[redacted]')
        ) {
          return resolve(prepared);
        }

        const hasValidKey = !isRedactedSecret(profile.apiKey);
        if (hasValidKey) {
          prepared.authMode = 'api-key';
          return resolve(prepared);
        }
      } else {
        // 官方特权路由，忽略并擦除任何客户端传入的自定义 API key，解耦原有密钥，仅允许从本地官方凭据或配置加载
        const profileId = profile.id ? String(profile.id).toLowerCase() : '';
        const configuredProfiles = profilesSnapshot() || [];
        const globalProfile = profileId
          ? configuredProfiles.find((p) => p.id && String(p.id).toLowerCase() === profileId)
          : null;
        let allowedConfigKey = null;
        if (globalProfile && globalProfile.apiKey) {
          let key = globalProfile.apiKey;
          if (
            key.startsWith('hpm-enc:') ||
            key.startsWith('hpm-dpapi:') ||
            key.startsWith('hpm-aes-v2:')
          ) {
            key = decryptKey(key);
          }
          if (!isRedactedSecret(key)) {
            allowedConfigKey = key;
          }
        }

        if (profile.apiKey !== allowedConfigKey) {
          profile.apiKey = null;
        }
      }

      if (provider === 'google') {
        if (requestedAuthMode === 'api-key') {
          prepared.authMode = 'api-key';
          prepared.authProvider = 'google';
          return resolve(prepared);
        }

        const localCreds = readGoogleOfficialCredentialFile();
        if (localCreds) {
          const { credsPath, content } = localCreds;
          const hasExpired = content.expiry_date && Date.now() > content.expiry_date - 300000;

          if (hasExpired && content.refresh_token) {
            const isReadOnlyAntigravity = isReadOnlyAntigravityCredential(content);
            const refreshPromise = isReadOnlyAntigravity
              ? getFreshAntigravityOfficialAccessToken()
              : refreshGoogleAccessToken(credsPath, content);
            if (!isReadOnlyAntigravity) {
              safeLog.info('[auth] Google OAuth token expired or expiring soon, refreshing...');
            }
            refreshPromise
              .then((newToken) => {
                resolveGoogleOfficialLoginPrepared(prepared, profile, newToken, resolve);
              })
              .catch((err) => {
                if (isReadOnlyAntigravity) {
                  reject(new AntigravityCredentialError('ANTIGRAVITY_TOKEN_REFRESH_FAILED'));
                  return;
                }
                safeLog.error('[auth] Failed to refresh Google token:', err.message);
                if (
                  !isRedactedSecret(profile.apiKey) &&
                  isGoogleOfficialLoginToken(profile.apiKey)
                ) {
                  resolveGoogleOfficialLoginPrepared(prepared, profile, profile.apiKey, resolve);
                  return;
                } else if (content.access_token) {
                  resolveGoogleOfficialLoginPrepared(
                    prepared,
                    profile,
                    content.access_token,
                    resolve
                  );
                  return;
                }
                resolve(prepared);
              });
            return;
          } else if (content.access_token) {
            resolveGoogleOfficialLoginPrepared(prepared, profile, content.access_token, resolve);
            return;
          }
        } else if (
          !isRedactedSecret(profile.apiKey) &&
          isGoogleOfficialLoginToken(profile.apiKey)
        ) {
          resolveGoogleOfficialLoginPrepared(prepared, profile, profile.apiKey, resolve);
          return;
        }
      }

      if (provider === 'openai') {
        if (requestedAuthMode === 'api-key') {
          prepared.authMode = 'api-key';
          prepared.authProvider = 'openai';
          return resolve(prepared);
        }
        if (!isRedactedSecret(profile.apiKey)) {
          prepared.authMode = 'official-login';
          prepared.authProvider = 'openai';
          if (
            prepared.authMode === 'official-login' &&
            shouldUseChatGPTBackendForOfficialLogin(profile.targetUrl)
          ) {
            prepared.profile = { ...profile, targetUrl: 'https://chatgpt.com/backend-api/codex' };
          }
          return resolve(prepared);
        }

        const authPath = path.join(os.homedir(), '.codex', 'auth.json');
        if (fs.existsSync(authPath)) {
          try {
            const content = JSON.parse(fs.readFileSync(authPath, 'utf8'));
            const token =
              (content.tokens && content.tokens.access_token) || content.OPENAI_API_KEY || null;
            if (token && token !== 'PROXY_MANAGED') {
              prepared.profile = { ...profile, apiKey: token };
              if (token.startsWith('eyJ')) {
                if (shouldUseChatGPTBackendForOfficialLogin(profile.targetUrl)) {
                  prepared.profile.targetUrl = 'https://chatgpt.com/backend-api/codex';
                }
                prepared.authMode = 'official-login';
              } else {
                prepared.authMode = 'api-key';
              }
              prepared.authProvider = 'openai';
            }
          } catch (e) {
            safeLog.error('[auth] Error loading Codex OAuth credentials:', e.message);
          }
        }
      }

      if (provider === 'trae') {
        prepared.authMode = 'official-login';
        prepared.authProvider = 'trae';
        prepared.profile = {
          ...profile,
          protocol: 'trae',
          targetUrl: profile.targetUrl || TRAE_OFFICIAL_TARGET_URL,
          apiKey: null,
        };
        prepared.traeOfficialStorage = readTraeStorageSummary();
        return resolve(prepared);
      }

      if (provider === 'tianxi') {
        prepared.authMode = 'official-login';
        prepared.authProvider = 'tianxi';
        prepared.profile = {
          ...profile,
          protocol: 'tianxi',
          targetUrl: profile.targetUrl || TIANXI_OFFICIAL_TARGET_URL,
          apiKey: null,
        };
        return resolve(prepared);
      }

      if (provider === 'workbuddy') {
        prepared.authMode = 'official-login';
        prepared.authProvider = 'workbuddy';
        const {
          readWorkBuddyAuthInfo,
          WORKBUDDY_DEFAULT_TARGET_URL,
        } = require('./workbuddy-official');

        const targetUrl =
          profile.targetUrl && profile.targetUrl !== 'https://copilot.tencent.com'
            ? profile.targetUrl
            : WORKBUDDY_DEFAULT_TARGET_URL;
        const authInfo = readWorkBuddyAuthInfo();
        if (authInfo && authInfo.accessToken) {
          prepared.profile = {
            ...profile,
            protocol: 'workbuddy',
            targetUrl,
            apiKey: authInfo.accessToken,
            uin: authInfo.uin,
            uid: authInfo.uid,
          };
          prepared.workbuddyAuth = authInfo;
        } else if (!isRedactedSecret(profile.apiKey)) {
          prepared.profile = {
            ...profile,
            protocol: 'workbuddy',
            targetUrl,
          };
        } else {
          prepared.profile = {
            ...profile,
            protocol: 'workbuddy',
            targetUrl,
            apiKey: null,
          };
        }
        return resolve(prepared);
      }

      resolve(prepared);
    });
  }

  return {
    decryptProfileApiKey,
    resolveConfiguredProfile,
    resolveOfficialCredentials,
  };
}

module.exports = { createAuthResolver };
