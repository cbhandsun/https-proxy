'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const moduleReady = import('../../tauri-ui/src/app/domains/context-policy-controls.js');
const revision = 'a'.repeat(64);
const nextRevision = 'b'.repeat(64);
const preview = (overrides = {}) => ({
  ok: true,
  revision,
  fromVersion: 1,
  targetVersion: 2,
  migrationRequired: true,
  requestedPolicy: 'native-first',
  requestedRecovery: false,
  persistencePreference: true,
  impacts: ['automatic_trimming_disabled', 'evidence_dependent_history_requires_recovery'],
  ...overrides,
});
const applied = (overrides = {}) => ({
  ok: true,
  saved: true,
  changed: true,
  revision: nextRevision,
  targetVersion: 2,
  runtimeApplication: 'pending',
  ...overrides,
});

async function fixture(options = {}) {
  const { bindContextPolicyControls } = await moduleReady;
  const button = { disabled: false, setAttribute() {} };
  const status = { textContent: '' };
  let current = {
    _revision: revision,
    appSettings: { contextRecoveryEnabled: false, contextRecoveryPersistenceEnabled: true },
    localDraft: 'preserved',
  };
  const calls = [];
  const dialogs = [];
  bindContextPolicyControls({
    getElement: (id) => (id === 'applyContextPolicy' ? button : status),
    getConfig: () => current,
    getApiBase: () => '',
    confirmAction: async (value) => {
      dialogs.push(value);
      return true;
    },
    fetchRequest: async (url, request) => {
      calls.push({ url, request });
      return { ok: true, json: async () => (url.endsWith('preview') ? preview() : applied()) };
    },
    ...options,
  });
  return {
    button,
    status,
    calls,
    dialogs,
    current: () => current,
    replace: (value) => {
      current = value;
    },
  };
}

test('policy UI previews, explains legacy chat limitations, applies once and preserves local drafts', async () => {
  const f = await fixture();
  await f.button.onclick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, '/v1/local/context-policy/preview');
  assert.equal(f.calls[0].request.method, 'GET');
  assert.equal(f.calls[1].url, '/v1/local/context-policy/apply');
  assert.deepEqual(JSON.parse(f.calls[1].request.body), {
    confirm: true,
    revision,
    targetVersion: 2,
  });
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0].message, /旧聊天/);
  assert.match(f.dialogs[0].message, /尚未保存/);
  assert.equal(f.current()._revision, nextRevision);
  assert.equal(f.current().appSettings.contextPolicyVersion, 2);
  assert.equal(f.current().appSettings.contextRecoveryPersistenceEnabled, true);
  assert.equal(f.current().localDraft, 'preserved');
  assert.match(f.status.textContent, /已保存并请求代理重载/);
  assert.equal(f.button.disabled, false);
});

test('policy response parsers reject malformed, unknown, extreme, private and executable values', async () => {
  const { parsePolicyPreview, parsePolicyApplied } = await moduleReady;
  let calls = 0;
  const executable = Object.defineProperty(preview(), 'ok', {
    enumerable: true,
    get() {
      calls++;
      throw new Error('PRIVATE');
    },
  });
  const impact = preview();
  Object.defineProperty(impact.impacts, '0', {
    get() {
      calls++;
      throw new Error('PRIVATE');
    },
  });
  for (const value of [
    null,
    [],
    {},
    false,
    '',
    new Date(),
    executable,
    impact,
    preview({ targetVersion: 3 }),
    preview({ fromVersion: 0 }),
    preview({ migrationRequired: false }),
    preview({ requestedRecovery: 'true' }),
    preview({ persistencePreference: null }),
    preview({ requestedPolicy: 'other' }),
    preview({ impacts: ['PRIVATE'] }),
    preview({ revision: 'a'.repeat(100000) }),
    preview({ private: 'PRIVATE' }),
    { ...preview(), [Symbol('PRIVATE')]: true },
  ])
    assert.equal(parsePolicyPreview(value), null);
  for (const value of [
    null,
    [],
    {},
    applied({ saved: false }),
    applied({ changed: null }),
    applied({ runtimeApplication: 'active' }),
    applied({ targetVersion: 3 }),
    applied({ revision: '' }),
    applied({ private: 'PRIVATE' }),
    Object.defineProperty(applied(), 'ok', {
      get() {
        calls++;
        throw new Error('PRIVATE');
      },
    }),
  ])
    assert.equal(parsePolicyApplied(value), null);
  assert.equal(calls, 0);
  assert.deepEqual(parsePolicyApplied(applied()), { revision: nextRevision });
  assert.deepEqual(parsePolicyPreview(preview()), {
    revision,
    migrationRequired: true,
    recovery: false,
  });
});

test('missing revision, preview mismatch, cancel and already-current states never send apply', async () => {
  for (const mode of ['missing', 'conflict', 'cancel', 'current', 'invalid']) {
    const calls = [];
    const f = await fixture({
      confirmAction: async () => false,
      fetchRequest: async (url) => {
        calls.push(url);
        return {
          ok: true,
          json: async () =>
            mode === 'invalid'
              ? {}
              : preview({
                  ...(mode === 'conflict' ? { revision: nextRevision } : {}),
                  ...(mode === 'current' ? { fromVersion: 2, migrationRequired: false } : {}),
                }),
        };
      },
    });
    if (mode === 'missing') delete f.current()._revision;
    await f.button.onclick();
    assert.equal(calls.length, mode === 'missing' ? 0 : 1);
    assert.equal(f.current().appSettings.contextPolicyVersion, undefined);
    assert.equal(f.button.disabled, false);
  }
});

test('enhanced migration explains retained saved preferences and detects state changes while confirming', async () => {
  let dialog;
  let f;
  f = await fixture({
    confirmAction: async (value) => {
      dialog = value;
      f.current()._revision = nextRevision;
      return true;
    },
    fetchRequest: async () => ({
      ok: true,
      json: async () =>
        preview({
          requestedRecovery: true,
          requestedPolicy: 'enhanced',
          impacts: ['existing_recovery_preferences_retained'],
        }),
    }),
  });
  await f.button.onclick();
  assert.match(dialog.message, /保留已保存的自动恢复/);
  assert.match(f.status.textContent, /页面配置已变化/);
  assert.equal(f.current().appSettings.contextPolicyVersion, undefined);
});

test('transport, malformed replies, rejected confirmation and lost responses never leak details or retry mutations', async () => {
  for (const mode of ['throw', 'http', 'json', 'invalid', 'confirm', 'replace']) {
    let calls = 0;
    let f;
    f = await fixture({
      confirmAction: async () => {
        if (mode === 'confirm') throw new Error('PRIVATE');
        return true;
      },
      fetchRequest: async (url) => {
        calls++;
        if (url.endsWith('preview')) return { ok: true, json: async () => preview() };
        if (mode === 'throw') throw new Error('PRIVATE');
        if (mode === 'replace') f.replace({ _revision: nextRevision, appSettings: {} });
        return {
          ok: mode !== 'http',
          json: async () => {
            if (mode === 'json') throw new Error('PRIVATE');
            return mode === 'invalid' ? {} : applied();
          },
        };
      },
    });
    await f.button.onclick();
    assert.equal(calls, mode === 'confirm' ? 1 : 2);
    assert.equal(f.current().appSettings.contextPolicyVersion, undefined);
    assert.doesNotMatch(f.status.textContent, /PRIVATE/);
    assert.match(f.status.textContent, /未确认/);
    assert.equal(f.button.disabled, false);
  }
});

test('pending actions coalesce and a timed-out apply is never repeated automatically', async () => {
  let expire;
  let calls = 0;
  let started;
  const pending = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture({
    setTimer: (callback) => {
      expire = callback;
      return 1;
    },
    cancelTimer() {},
    fetchRequest: async (url) => {
      calls++;
      if (url.endsWith('preview')) return { ok: true, json: async () => preview() };
      started();
      return new Promise(() => {});
    },
  });
  const action = f.button.onclick();
  await pending;
  await f.button.onclick();
  assert.equal(calls, 2);
  expire();
  await action;
  assert.equal(calls, 2);
  assert.match(f.status.textContent, /未确认/);
  assert.equal(f.button.disabled, false);
});

test('migration controls are wired into the composition root and accessible static markup', () => {
  const html = fs.readFileSync('tauri-ui/index.html', 'utf8');
  const bootstrap = fs.readFileSync('tauri-ui/src/app/bootstrap.js', 'utf8');
  assert.match(html, /id="applyContextPolicy" type="button"/);
  assert.match(
    html,
    /id="contextPolicyMigrationStatus"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/
  );
  assert.match(bootstrap, /bindContextPolicyControls\(\{/);
});

test('recovery settings explain native defaults, public generation cost and independent retention accessibly', () => {
  const html = fs.readFileSync('tauri-ui/index.html', 'utf8');
  for (const [control, description] of [
    ['contextRecoveryEnabled', 'contextRecoveryDescription'],
    ['contextRecoveryPersistenceEnabled', 'contextRecoveryPersistenceDescription'],
  ]) {
    const input = html.match(new RegExp(`<input\\b[^>]*id="${control}"[^>]*>`))?.[0];
    assert.ok(input, `missing ${control}`);
    assert.match(input, /type="checkbox"/);
    assert.match(input, new RegExp(`aria-describedby="${description}"`));
    assert.doesNotMatch(input, /\bchecked\b/);
    assert.equal(html.match(new RegExp(`id="${description}"`, 'g'))?.length, 1);
  }
  const recovery = html.match(/id="contextRecoveryDescription"[^>]*>([^<]*)<\/span\s*>/)?.[1];
  assert.ok(recovery);
  assert.match(recovery, /新策略默认由客户端原生压缩/);
  assert.match(recovery, /内部完成，再独立生成公开答案/);
  assert.match(recovery, /增加模型调用和等待/);
  assert.match(recovery, /完整兼容未验收/);
  const persistence = html.match(
    /id="contextRecoveryPersistenceDescription"[^>]*>([^<]*)<\/span\s*>/
  )?.[1];
  assert.ok(persistence);
  assert.match(persistence, /仅开启留存不会开启恢复或授予原文读取权限/);
  assert.match(persistence, /期限以运行状态为准，已有记录不续期/);
});
