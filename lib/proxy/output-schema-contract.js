'use strict';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const types = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);

// Called after bounded JSON validation. Walk only schema positions: defaults,
// examples and enum values are data, not nested schema declarations.
function validateSchemaKeywords(schema, invalid) {
  function strings(value) {
    return (
      Array.isArray(value) &&
      value.every((item) => typeof item === 'string') &&
      new Set(value).size === value.length
    );
  }
  function check(node) {
    if (typeof node === 'boolean') return;
    if (!record(node)) invalid();
    if (Object.hasOwn(node, 'type')) {
      const value = node.type;
      if (
        !(typeof value === 'string'
          ? types.has(value)
          : strings(value) && value.length > 0 && value.every((item) => types.has(item)))
      )
        invalid();
    }
    for (const key of [
      '$id',
      '$schema',
      '$ref',
      '$anchor',
      'title',
      'description',
      'format',
      'pattern',
    ])
      if (Object.hasOwn(node, key) && typeof node[key] !== 'string') invalid();
    for (const key of ['required', 'propertyOrdering'])
      if (Object.hasOwn(node, key) && !strings(node[key])) invalid();
    for (const key of [
      'minItems',
      'maxItems',
      'minLength',
      'maxLength',
      'minProperties',
      'maxProperties',
      'minContains',
      'maxContains',
    ])
      if (Object.hasOwn(node, key) && (!Number.isSafeInteger(node[key]) || node[key] < 0))
        invalid();
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'])
      if (
        Object.hasOwn(node, key) &&
        (typeof node[key] !== 'number' ||
          !Number.isFinite(node[key]) ||
          (key === 'multipleOf' && node[key] <= 0))
      )
        invalid();
    for (const key of ['uniqueItems', 'readOnly', 'writeOnly', 'deprecated'])
      if (Object.hasOwn(node, key) && typeof node[key] !== 'boolean') invalid();
    if (Object.hasOwn(node, 'enum') && (!Array.isArray(node.enum) || node.enum.length === 0))
      invalid();
    for (const key of [
      'properties',
      'patternProperties',
      '$defs',
      'definitions',
      'dependentSchemas',
    ]) {
      if (!Object.hasOwn(node, key)) continue;
      if (!record(node[key])) invalid();
      Object.values(node[key]).forEach(check);
    }
    for (const key of [
      'items',
      'additionalProperties',
      'additionalItems',
      'contains',
      'not',
      'if',
      'then',
      'else',
      'propertyNames',
      'unevaluatedItems',
      'unevaluatedProperties',
    ])
      if (Object.hasOwn(node, key)) check(node[key]);
    for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
      if (!Object.hasOwn(node, key)) continue;
      if (!Array.isArray(node[key]) || node[key].length === 0) invalid();
      node[key].forEach(check);
    }
    if (Object.hasOwn(node, 'dependentRequired')) {
      if (!record(node.dependentRequired) || !Object.values(node.dependentRequired).every(strings))
        invalid();
    }
  }
  check(schema);
  return schema;
}

module.exports = { validateSchemaKeywords };
