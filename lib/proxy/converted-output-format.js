'use strict';

const { validateOutputSchema, validateGeminiOutputSchema } = require('./claude-modern-options');
const geminiJsonMode = Symbol('validatedGeminiJsonMode');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalidFormat() {
  const error = new TypeError('Output format is invalid or unsupported by this conversion target');
  error.code = 'invalid_request_error';
  throw error;
}
function parseFormat(format, shape) {
  if (!record(format) || typeof format.type !== 'string') invalidFormat();
  if (format.type === 'text' || format.type === 'json_object') {
    if (Object.keys(format).some((key) => key !== 'type')) invalidFormat();
    return { type: format.type };
  }
  if (format.type !== 'json_schema') invalidFormat();
  const spec = shape === 'chat' ? format.json_schema : format;
  if (!record(spec)) invalidFormat();
  if (shape === 'chat' && Object.keys(format).some((key) => !['type', 'json_schema'].includes(key)))
    invalidFormat();
  const allowedKeys =
    shape === 'chat'
      ? ['name', 'description', 'schema', 'strict']
      : ['type', 'name', 'description', 'schema', 'strict'];
  if (Object.keys(spec).some((key) => !allowedKeys.includes(key))) invalidFormat();
  if (typeof spec.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(spec.name)) invalidFormat();
  if (spec.strict != null && typeof spec.strict !== 'boolean') invalidFormat();
  if (spec.description != null && typeof spec.description !== 'string') invalidFormat();
  return {
    type: 'json_schema',
    schema: validateOutputSchema(spec.schema),
    strict: spec.strict ?? false,
  };
}
function convertedOutputFormat(source, shape, target, model, options = {}) {
  if (
    !record(source) ||
    !['chat', 'responses'].includes(shape) ||
    !['Claude', 'Gemini', 'Chat'].includes(target)
  )
    invalidFormat();
  if (shape === 'responses' && source.text != null && !record(source.text)) invalidFormat();
  const formats = [];
  function normalize(format, shape) {
    const parsed = parseFormat(format, shape);
    if (target === 'Chat' && parsed.type === 'json_schema') {
      const spec = shape === 'chat' ? format.json_schema : format;
      return {
        ...parsed,
        name: spec.name,
        ...(spec.description != null ? { description: spec.description } : {}),
      };
    }
    return parsed;
  }
  if (source.response_format != null) formats.push(normalize(source.response_format, 'chat'));
  if (shape === 'responses' && source.text?.format != null)
    formats.push(normalize(source.text.format, 'responses'));
  if (!formats.length) return null;
  if (formats.some((format) => JSON.stringify(format) !== JSON.stringify(formats[0])))
    invalidFormat();
  const format = formats[0];
  if (format.type === 'text') return null;
  if (target === 'Gemini' && options.codeAssist === true) invalidFormat();
  // DeepSeek's Anthropic-compatible endpoint accepts output_config without
  // enforcing its schema. Do not report a successful structured-output mapping.
  if (target === 'Claude' && typeof model === 'string' && /(?:^|\/)deepseek(?:-|$)/i.test(model))
    invalidFormat();
  if (target === 'Gemini' && /[- ]image(?:[- ]|$)/i.test(model || '')) invalidFormat();
  if (format.type === 'json_object') {
    if (target !== 'Gemini' && target !== 'Chat') invalidFormat();
    return format;
  }
  if (target === 'Gemini') validateGeminiOutputSchema(format.schema);
  return format;
}
function applyConvertedOutputFormat(config, source, shape, target, model) {
  const format = convertedOutputFormat(source, shape, target, model);
  if (!format) return config;
  if (target === 'Chat') {
    config.response_format =
      format.type === 'json_object'
        ? { type: 'json_object' }
        : {
            type: 'json_schema',
            json_schema: {
              name: format.name,
              schema: format.schema,
              strict: format.strict,
              ...(format.description != null ? { description: format.description } : {}),
            },
          };
    return config;
  }
  if (format.type === 'json_object') config[geminiJsonMode] = true;
  else config.output_config = { format: { type: 'json_schema', schema: format.schema } };
  return config;
}
module.exports = { convertedOutputFormat, applyConvertedOutputFormat, geminiJsonMode };
