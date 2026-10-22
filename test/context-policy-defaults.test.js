'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const { DEFAULT_CONFIG } = require('../lib/proxy/config');
const {
  parseContextPolicy,
  composeContextProtocolOptions,
  usesNativeContextPlanning,
} = require('../lib/proxy/context-recovery-policy');
const { validateConfig } = require('../lib/proxy/validator');

test('both first-start configuration sources select native planning with recovery and capture disabled', () => {
  const example = JSON.parse(fs.readFileSync('proxy.config.example.json', 'utf8'));
  for (const config of [DEFAULT_CONFIG, example]) {
    assert.equal(validateConfig(config).valid, true);
    assert.equal(config.appSettings.contextPolicyVersion, 2);
    assert.equal(config.appSettings.contextRecoveryEnabled, false);
    assert.equal(config.appSettings.contextRecoveryPersistenceEnabled, false);
    assert.equal(config.appSettings.contextEvidenceEnabled, false);
    assert.equal(parseContextPolicy(config).requestedPolicy, 'native-first');
    assert.equal(
      usesNativeContextPlanning(
        composeContextProtocolOptions(DEFAULT_CONFIG.protocolOptions, config)
      ),
      true
    );
  }
});

test('missing-file defaults are isolated copies and never create or migrate an existing config', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-policy-default-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = createIsolatedTestEnv(process.env, directory);
  const source = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { loadConfig, DEFAULT_CONFIG, CONFIG_FILE } = require('./lib/proxy/config');
    const { parseContextPolicy } = require('./lib/proxy/context-recovery-policy');
    const initial = loadConfig({throwOnError:true});
    assert.equal(parseContextPolicy(initial).requestedPolicy,'native-first');
    assert.equal(fs.existsSync(CONFIG_FILE),false);
    initial.appSettings.contextPolicyVersion=1;
    initial.profiles[0].protocol='mutated';
    assert.equal(loadConfig({throwOnError:true}).appSettings.contextPolicyVersion,2);
    assert.equal(DEFAULT_CONFIG.profiles[0].protocol,'openai');
    const { validateConfig } = require('./lib/proxy/validator');
    assert.equal(validateConfig(loadConfig({throwOnError:true})).valid,true);
    process.stdout.write('ok');
  `;
  assert.match(execFileSync(process.execPath, ['-e', source], { env, encoding: 'utf8' }), /ok$/);
});

test('loading legacy files preserves policy and exact bytes; the new example selects version 2 only when copied', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-policy-legacy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = createIsolatedTestEnv(process.env, directory);
  fs.mkdirSync(env.PROXY_CONFIG_DIR, { recursive: true });
  const file = path.join(env.PROXY_CONFIG_DIR, 'proxy.config.json');
  const inspect = `
    const assert=require('node:assert/strict'), fs=require('node:fs');
    const {loadConfig,CONFIG_FILE}=require('./lib/proxy/config');
    const {parseContextPolicy}=require('./lib/proxy/context-recovery-policy');
    const before=fs.readFileSync(CONFIG_FILE,'utf8');
    const raw=JSON.parse(before);
    const expected=raw.appSettings?.contextPolicyVersion??1;
    const loaded=loadConfig({throwOnError:true});
    assert.equal(parseContextPolicy(loaded).version,expected);
    assert.equal(loaded.appSettings?.contextRecoveryEnabled,raw.appSettings?.contextRecoveryEnabled);
    assert.equal(loaded.appSettings?.contextRecoveryPersistenceEnabled,raw.appSettings?.contextRecoveryPersistenceEnabled);
    assert.equal(fs.readFileSync(CONFIG_FILE,'utf8'),before);
    process.stdout.write('ok');
  `;
  for (const settings of [
    undefined,
    {},
    { contextRecoveryEnabled: false },
    {
      contextPolicyVersion: 1,
      contextRecoveryEnabled: true,
      contextRecoveryPersistenceEnabled: true,
    },
  ]) {
    fs.writeFileSync(
      file,
      JSON.stringify({
        profiles: [{ id: 'main', protocol: 'openai', targetUrl: 'https://example.test/v1' }],
        activeProfile: 'main',
        ...(settings === undefined ? {} : { appSettings: settings }),
      })
    );
    assert.match(execFileSync(process.execPath, ['-e', inspect], { env, encoding: 'utf8' }), /ok$/);
  }
  fs.copyFileSync('proxy.config.example.json', file);
  assert.match(execFileSync(process.execPath, ['-e', inspect], { env, encoding: 'utf8' }), /ok$/);
});
