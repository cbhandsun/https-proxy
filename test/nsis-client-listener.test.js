'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  installedListenerPaths,
  installedClientRequest,
} = require('../scripts/context-hosted/shared/installed-client-listener-policy');
const {
  createInstalledClientListener,
} = require('../scripts/context-hosted/shared/hosted-listener');
test('installed client listener binds only fixed owned paths on hosted Windows', () => {
  const temporary = path.resolve('synthetic-runner-temp');
  const runtime = {
    platform: 'win32',
    env: {
      RUNNER_TEMP: temporary,
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_OS: 'Windows',
    },
  };
  const input = {
    networkRoot: path.join(temporary, 'hpm-installed-clients/n08-hosted-network'),
    ownedNode: path.join(temporary, 'hpm-installed-clients/payload/runtime/node/node.exe'),
    negativeAddress: '192.168.1.2',
    onBusinessRequest() {},
  };
  assert.equal(installedListenerPaths(input, runtime), true);
  for (const field of ['networkRoot', 'ownedNode'])
    for (const value of [
      '',
      'relative',
      path.resolve('other'),
      input[field] + '\n',
      'x'.repeat(10000),
    ])
      assert.throws(() => installedListenerPaths({ ...input, [field]: value }, runtime));
  for (const key of ['GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_TEMP'])
    assert.throws(() =>
      installedListenerPaths(input, { ...runtime, env: { ...runtime.env, [key]: '' } })
    );
  assert.throws(() => installedListenerPaths(input, { ...runtime, platform: 'darwin' }));
  let accessed = false;
  const hostile = { ...input };
  Object.defineProperty(hostile, 'ownedNode', {
    enumerable: true,
    get() {
      accessed = true;
      throw Error('private');
    },
  });
  assert.throws(() => installedListenerPaths(hostile, runtime));
  assert.equal(accessed, false);
});
test('installed client TLS paths require exact official SNI and protocol', () => {
  for (const url of ['/v1/responses', '/v1/responses/compact'])
    assert.equal(installedClientRequest(url, 'api.openai.com'), true);
  for (const url of ['/v1/messages', '/v1/messages?beta=true'])
    assert.equal(installedClientRequest(url, 'api.anthropic.com'), true);
  for (const host of [
    '',
    null,
    'localhost',
    'api.openai.com.evil',
    'api.anthropic.com.evil',
    'API.OPENAI.COM',
  ])
    for (const url of ['/v1/responses', '/v1/messages'])
      assert.equal(installedClientRequest(url, host), false);
  assert.equal(installedClientRequest('/v1/messages', 'api.openai.com'), false);
  assert.equal(installedClientRequest('/v1/responses', 'api.anthropic.com'), false);
  for (const url of ['', null, '/v1/messages?beta=false', '/v1/responses?x=1', '/v1/../messages'])
    assert.equal(installedClientRequest(url, 'api.anthropic.com'), false);
});
test('installed listener refuses unsupported host before opening any socket', async () => {
  await assert.rejects(
    createInstalledClientListener({
      networkRoot: path.resolve('missing'),
      ownedNode: process.execPath,
      negativeAddress: '192.168.1.2',
      onBusinessRequest() {},
    })
  );
});
