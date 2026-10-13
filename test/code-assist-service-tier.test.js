'use strict';

const assert = require('node:assert/strict');
const { createCodeAssist } = require('../lib/proxy/handlers/code-assist');
const { convertedServiceTier } = require('../lib/proxy/converted-service-tier');

const api = createCodeAssist({ fallbackId: () => 'fixture' });
const prepared = {
  model: 'gemini-3.8-flash-tiered',
  googleOfficialProjectId: 'fixture',
};
function compile(body, stream) {
  return api.codeAssistGenerateRequest(prepared, body, prepared.model, stream);
}

for (const stream of [false, true]) {
  for (const tier of [undefined, null, 'unspecified', 'standard', 'priority', 'flex']) {
    const body = { contents: [], serviceTier: tier };
    const snapshot = JSON.stringify(body);
    assert.equal(Object.hasOwn(compile(body, stream).body.request, 'serviceTier'), false);
    assert.equal(JSON.stringify(body), snapshot);
  }
  for (const value of [
    '',
    'default',
    'standard_only',
    'PRIORITY',
    ' priority ',
    1,
    false,
    {},
    [],
    'sensitive'.repeat(10000),
    {
      toString() {
        throw new Error('sensitive');
      },
    },
  ]) {
    assert.throws(
      () => compile({ contents: [], serviceTier: value }, stream),
      (error) => {
        assert.equal(error.code, 'invalid_request_error');
        assert.equal(
          error.message,
          'Requested service tier cannot be preserved by this conversion target'
        );
        return true;
      }
    );
  }
  for (const source of ['openai', 'claude']) {
    const values =
      source === 'claude'
        ? ['auto', 'standard_only', 'priority', 'flex']
        : ['auto', 'default', 'priority', 'flex'];
    for (const value of values) {
      const tier = convertedServiceTier(value, source, 'Gemini');
      assert.equal(
        Object.hasOwn(
          compile({ contents: [], serviceTier: tier }, stream).body.request,
          'serviceTier'
        ),
        false
      );
      assert.equal(convertedServiceTier(value, source, 'Gemini', { codeAssist: true }), undefined);
    }
  }
}
