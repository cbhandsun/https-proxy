'use strict';
const { types } = require('node:util');
const { snapshot } = require('../n09-ipc/lifecycle-channel.js');
const fail = () => new Error('n09_synthetic_profiles_invalid');
const expected = Object.freeze([
  Object.freeze({
    id: 'n09-synthetic',
    name: 'N09 synthetic',
    protocol: 'openai',
    targetUrl: 'https://api.openai.com/v1',
    apiKey: '[redacted]',
    authMode: 'api-key',
  }),
  Object.freeze({
    id: 'tianxi-official',
    name: 'Tianxi Official',
    protocol: 'tianxi',
    targetUrl: 'http://127.0.0.1:49305',
    apiKey: null,
    authMode: 'official-login',
  }),
  Object.freeze({
    id: 'workbuddy-official',
    name: 'WorkBuddy Official',
    protocol: 'workbuddy',
    targetUrl: 'https://copilot.tencent.com/v2',
    apiKey: null,
    authMode: 'official-login',
  }),
]);

// loadConfig adds both built-in profiles; management GET redacts the synthetic key.
// Validate that exact effective representation, including the inactive defaults.
function assertSyntheticProfileReadback(input) {
  try {
    if (
      !input ||
      types.isProxy(input) ||
      !Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Array.prototype ||
      input.length !== 3 ||
      Reflect.ownKeys(input).length !== 4
    )
      throw fail();
    const seen = new Set();
    for (let index = 0; index < 3; index++) {
      const slot = Object.getOwnPropertyDescriptor(input, String(index));
      if (!slot || !Object.hasOwn(slot, 'value')) throw fail();
      const profile = snapshot(slot.value);
      if (Object.keys(profile).length !== 6) throw fail();
      const canonical = expected.find((value) => value.id === profile.id);
      if (
        !canonical ||
        seen.has(profile.id) ||
        Object.keys(canonical).some((key) => profile[key] !== canonical[key])
      )
        throw fail();
      seen.add(profile.id);
    }
    return true;
  } catch {
    throw fail();
  }
}
module.exports = { assertSyntheticProfileReadback };
