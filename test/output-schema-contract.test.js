'use strict';
const assert = require('node:assert/strict');
const {
  validateOutputSchema,
  validateGeminiOutputSchema,
} = require('../lib/proxy/claude-modern-options');

const valid = [
  {},
  { type: ['string', 'null'], enum: ['answer', null], default: { type: 'data-not-schema' } },
  {
    type: 'object',
    required: [],
    properties: { answer: { type: 'string', minLength: 0 } },
    additionalProperties: false,
  },
  {
    type: 'array',
    items: { type: 'integer', minimum: -10 },
    minItems: 0,
    maxItems: Number.MAX_SAFE_INTEGER,
  },
  { $defs: { number: { type: 'number' } }, anyOf: [{ $ref: '#/$defs/number' }, { type: 'null' }] },
  { dependentRequired: { answer: ['source'] }, dependentSchemas: { answer: true } },
];
for (const schema of valid) {
  const before = JSON.stringify(schema);
  assert.equal(validateOutputSchema(schema), schema);
  assert.equal(JSON.stringify(schema), before);
}
const invalid = [
  { type: 'SECRET' },
  { type: [] },
  { type: ['string', 'string'] },
  { type: ['string', 'SECRET'] },
  { required: 7 },
  { required: ['answer', 1] },
  { required: ['answer', 'answer'] },
  { minimum: 'SECRET' },
  { maximum: null },
  { multipleOf: 0 },
  { minItems: -1 },
  { maxItems: 1.5 },
  { minLength: Number.MAX_SAFE_INTEGER + 1 },
  { properties: [] },
  { properties: { answer: { type: 'SECRET' } } },
  { anyOf: [] },
  { anyOf: ['SECRET'] },
  { items: null },
  { uniqueItems: 'SECRET' },
  { enum: [] },
  { enum: 'SECRET' },
  { additionalProperties: 'SECRET' },
  { $ref: [] },
  { dependentRequired: { answer: 'SECRET' } },
];
for (const validate of [validateOutputSchema, validateGeminiOutputSchema])
  for (const schema of invalid)
    assert.throws(
      () => validate(schema),
      (error) => error.code === 'invalid_request_error' && !error.message.includes('SECRET')
    );
for (const schema of [
  {},
  { type: 'object', required: [], properties: {}, additionalProperties: false },
  { type: 'number', minimum: 0 },
])
  assert.equal(validateGeminiOutputSchema(schema), schema);
// Data values must not be interpreted as schema declarations.
assert.equal(validateOutputSchema({ enum: [{ type: 'SECRET' }] }).enum[0].type, 'SECRET');
