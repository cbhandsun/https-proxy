'use strict';

const { geminiThinkingConfigFromOpenAI } = require('./reasoning-adapter');

// Only validated in-process compilers can install this capability. JSON input
// cannot impersonate a native thinking configuration through a string key.
const nativeGeminiThinking = Symbol('validatedNativeGeminiThinking');

function applyNativeGeminiReasoning(config, source, model) {
  config[nativeGeminiThinking] = geminiThinkingConfigFromOpenAI(source, model);
  return config;
}

module.exports = { nativeGeminiThinking, applyNativeGeminiReasoning };
