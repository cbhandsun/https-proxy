'use strict';

const CHANNELS = {
  'gemini-key': 'apiKeyModel',
  'gemini-official': 'officialModel',
};

function validateModel(value, official) {
  if (
    typeof value !== 'string' ||
    value.length > 160 ||
    !/^gemini-[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value) ||
    (!official && /-(?:tiered|low|medium|high|extra-low)$/.test(value))
  ) {
    throw new TypeError('Invalid Gemini probe model selection');
  }
  return value;
}

function selectGeminiProbeModels(specs, options = {}) {
  if (
    !Array.isArray(specs) ||
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !['apiKeyModel', 'officialModel'].includes(key))
  ) {
    throw new TypeError('Invalid Gemini probe model selection');
  }
  // Validate explicit choices even when a caller filters out their channel.
  for (const key of ['apiKeyModel', 'officialModel']) {
    if (options[key] !== undefined) validateModel(options[key], key === 'officialModel');
  }
  return specs.map((spec) => {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new TypeError('Invalid Gemini probe model selection');
    }
    const key = Object.hasOwn(CHANNELS, spec.label) ? CHANNELS[spec.label] : undefined;
    if (!key) return { ...spec };
    const explicit = options[key] !== undefined;
    return {
      ...spec,
      model: validateModel(explicit ? options[key] : spec.model, key === 'officialModel'),
      modelSelection: explicit ? 'explicit-probe-option' : 'historical-harness-choice',
    };
  });
}

module.exports = { selectGeminiProbeModels };
