'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createLogger } = require('./logger');

const safeLog = createLogger('antigravity-session');
const DEFAULT_LAUNCH_COOLDOWN_MS = 60 * 1000;
const MAX_LAUNCH_COOLDOWN_MS = 10 * 60 * 1000;

function boundedCooldownMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LAUNCH_COOLDOWN_MS;
  return Math.min(MAX_LAUNCH_COOLDOWN_MS, Math.max(5000, Math.trunc(parsed)));
}

function antigravityExecutableCandidates(env = process.env, homeDir = os.homedir()) {
  const localAppData =
    typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim()
      ? env.LOCALAPPDATA
      : path.join(homeDir, 'AppData', 'Local');
  return [path.resolve(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe')];
}

function resolveAntigravityExecutable({
  env = process.env,
  fsModule = fs,
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') return '';
  for (const candidate of antigravityExecutableCandidates(env, homeDir)) {
    try {
      const stat = fsModule.lstatSync(candidate);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0) return candidate;
    } catch {}
  }
  return '';
}

function createAntigravitySessionLauncher({
  env = process.env,
  fsModule = fs,
  getConfig = () => ({}),
  homeDir = os.homedir,
  now = Date.now,
  platform = process.platform,
  spawnProcess = spawn,
} = {}) {
  let launchInFlight = null;
  let lastLaunchAt = 0;

  return function launchAntigravitySession() {
    const config = typeof getConfig === 'function' ? getConfig() || {} : {};
    const appSettings = config.appSettings || {};
    if (appSettings.antigravitySessionRecoveryEnabled === false) {
      return Promise.resolve({ ok: false, reason: 'disabled' });
    }
    if (launchInFlight) return launchInFlight;

    const cooldownMs = boundedCooldownMs(appSettings.antigravitySessionLaunchCooldownMs);
    if (lastLaunchAt && now() - lastLaunchAt < cooldownMs) {
      return Promise.resolve({ ok: true, launched: false, reason: 'cooldown' });
    }

    const executablePath = resolveAntigravityExecutable({
      env,
      fsModule,
      homeDir: typeof homeDir === 'function' ? homeDir() : homeDir,
      platform,
    });
    if (!executablePath) return Promise.resolve({ ok: false, reason: 'missing_executable' });

    launchInFlight = new Promise((resolve) => {
      let child;
      try {
        child = spawnProcess(executablePath, [], {
          detached: true,
          env,
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        resolve({ ok: false, reason: 'spawn_failed' });
        return;
      }

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child.once('error', () => finish({ ok: false, reason: 'spawn_failed' }));
      child.once('spawn', () => {
        lastLaunchAt = now();
        if (typeof child.unref === 'function') child.unref();
        safeLog.info('[auth] Started Antigravity session recovery');
        finish({ ok: true, launched: true, reason: 'started' });
      });
    }).finally(() => {
      launchInFlight = null;
    });
    return launchInFlight;
  };
}

module.exports = {
  DEFAULT_LAUNCH_COOLDOWN_MS,
  MAX_LAUNCH_COOLDOWN_MS,
  antigravityExecutableCandidates,
  boundedCooldownMs,
  createAntigravitySessionLauncher,
  resolveAntigravityExecutable,
};
