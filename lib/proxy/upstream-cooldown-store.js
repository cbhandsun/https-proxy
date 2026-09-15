'use strict';

const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./config');
const { parseBoundedInteger, writeJsonFileAtomically } = require('./management-utils');

const COOLDOWN_STATE_FILE = path.join(DATA_DIR, 'upstream-cooldowns.json');
const MAX_PERSISTED_COOLDOWNS = 100;
const MAX_RESET_EPOCH_SECONDS = 4102444800; // 2100-01-01T00:00:00.000Z

function normalizePersistedCooldown(item, now = Date.now()) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const profileId = typeof item.profileId === 'string' ? item.profileId.trim().slice(0, 200) : '';
  const targetModel =
    typeof item.targetModel === 'string' ? item.targetModel.trim().slice(0, 200) : '';
  const until = parseBoundedInteger(item.until, 0, 0, MAX_RESET_EPOCH_SECONDS * 1000);
  if (!profileId || !targetModel || until <= now) return null;
  return {
    profileId,
    targetModel,
    until,
    source:
      typeof item.source === 'string' && item.source.trim() ? item.source.trim().slice(0, 100) : '',
  };
}

function readPersistedCooldowns(options = {}) {
  const filePath = options.filePath || COOLDOWN_STATE_FILE;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const items = Array.isArray(parsed && parsed.cooldowns) ? parsed.cooldowns : [];
    return items
      .slice(0, MAX_PERSISTED_COOLDOWNS)
      .map((item) => normalizePersistedCooldown(item, now))
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function writePersistedCooldowns(cooldowns, options = {}) {
  const filePath = options.filePath || COOLDOWN_STATE_FILE;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const items = (Array.isArray(cooldowns) ? cooldowns : [])
    .map((item) => normalizePersistedCooldown(item, now))
    .filter(Boolean)
    .sort((a, b) => b.until - a.until)
    .slice(0, MAX_PERSISTED_COOLDOWNS);
  writeJsonFileAtomically(
    filePath,
    {
      version: 1,
      updatedAt: new Date(now).toISOString(),
      cooldowns: items,
    },
    2
  );
}

module.exports = {
  COOLDOWN_STATE_FILE,
  MAX_PERSISTED_COOLDOWNS,
  normalizePersistedCooldown,
  readPersistedCooldowns,
  writePersistedCooldowns,
};
