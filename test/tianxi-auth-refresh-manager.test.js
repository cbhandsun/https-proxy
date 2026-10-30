'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTianxiAuthRefreshManager } = require('../lib/proxy/tianxi-auth-refresh-manager');
const {
  candidateMatches,
  exchangeTianxiToken,
  validIdentity,
  invokeNative,
} = require('../lib/proxy/tianxi-auth-exchange');
const {
  peData,
  loadAuthBuild,
  selectAuthBuild,
  BUILDS,
} = require('../lib/proxy/tianxi-auth-build');
const {
  refreshTianxiQoderToken,
  sanitizeRefreshState,
} = require('../lib/proxy/tianxi-token-refresh');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { SCRIPT } = require('../lib/proxy/tianxi-auth-native-script');
function jwt(exp, claims = {}) {
  return `sat-e30.${Buffer.from(JSON.stringify({ sub: 'owned-sub', iss: 'owned-issuer', aud: 'owned-aud', exp, ...claims })).toString('base64url')}.c2ln`;
}
test('authentication selects a complete supported build and rejects upgrades with mixed files', () => {
  for (const build of BUILDS) {
    assert.equal(selectAuthBuild({ ...build.files }), build);
    for (const name of Object.keys(build.files)) {
      assert.throws(
        () => selectAuthBuild({ ...build.files, [name]: '0'.repeat(64) }),
        /tianxi_auth_build_changed/
      );
      const missing = { ...build.files };
      delete missing[name];
      assert.throws(() => selectAuthBuild(missing), /tianxi_auth_build_changed/);
    }
  }
  for (const value of [null, undefined, {}, [], '', 1])
    assert.throws(() => selectAuthBuild(value), /tianxi_auth_build_changed/);
  assert.throws(
    () =>
      selectAuthBuild({ ...BUILDS[1].files, 'WrapPlugin.dll': BUILDS[0].files['WrapPlugin.dll'] }),
    /tianxi_auth_build_changed/
  );
  assert.equal(BUILDS[0].coreOffset, 0);
  assert.equal(BUILDS[1].coreOffset, 0x30a0);
});
function fixture() {
  let header = {
    user_id: 'owned-user',
    app_id: 'owned-app',
    device_id: 'owned-device',
    credentials: { qoder_token: jwt(1) },
  };
  return {
    get: () => header,
    set: (value) => {
      header = value;
    },
    options: () => ({ userId: header.user_id, readHeader: () => header }),
  };
}
test('no-chat refresh coalesces concurrent calls, reuses validated memory cache and never serializes token in status', async () => {
  const f = fixture();
  let calls = 0;
  const token = jwt(4000);
  const manager = createTianxiAuthRefreshManager({
    now: () => 1000000,
    exchange: async () => {
      calls++;
      await new Promise((r) => setImmediate(r));
      return token;
    },
  });
  const [a, b] = await Promise.all([manager.refresh(f.options()), manager.refresh(f.options())]);
  assert.equal(calls, 1);
  assert.equal(a.token, token);
  assert.equal(b.token, token);
  assert.equal(a.header.credentials.qoder_token, token);
  assert.equal((await manager.refresh(f.options())).status, 'fresh_cache');
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(sanitizeRefreshState(a)).includes(token), false);
  assert.equal(f.get().credentials.qoder_token, jwt(1));
});
test('failure backoff is bounded and provider errors are sanitized', async () => {
  const f = fixture();
  let now = 1000000,
    calls = 0;
  const manager = createTianxiAuthRefreshManager({
    now: () => now,
    exchange: async () => {
      calls++;
      throw new Error('private-token private-response');
    },
  });
  const failed = await manager.refresh(f.options());
  assert.equal(failed.errorCode, 'tianxi_auth_exchange_failed');
  assert.equal((await manager.refresh(f.options())).status, 'no_chat_backoff');
  assert.equal(calls, 1);
  now += 15000;
  await manager.refresh(f.options());
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(failed).includes('private'), false);
});

test('forced retry reuses a different cached token with a retryable status', async () => {
  const f = fixture();
  let calls = 0;
  const manager = createTianxiAuthRefreshManager({
    now: () => 1000000,
    exchange: async () => {
      calls++;
      return jwt(4000);
    },
  });
  await manager.refresh(f.options());
  const cached = await manager.refresh({ ...f.options(), force: true, previousToken: jwt(1) });
  assert.equal(cached.status, 'refreshed');
  assert.equal(cached.token, jwt(4000));
  assert.equal(calls, 1);
});

test('synchronous exchange failures are sanitized and enter backoff', async () => {
  const f = fixture();
  const manager = createTianxiAuthRefreshManager({
    now: () => 1000000,
    exchange: () => {
      throw new Error('private-error');
    },
  });
  const result = await manager.refresh(f.options());
  assert.equal(result.errorCode, 'tianxi_auth_exchange_failed');
  assert.equal((await manager.refresh(f.options())).status, 'no_chat_backoff');
});

test('refresh state capacity is bounded while all entries are in flight', async () => {
  const f = fixture();
  let resolve;
  const manager = createTianxiAuthRefreshManager({
    now: () => 1000000,
    maxEntries: 1,
    exchange: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  const pending = manager.refresh(f.options());
  const other = fixture();
  other.set({ ...other.get(), device_id: 'other-device' });
  assert.equal((await manager.refresh(other.options())).status, 'no_chat_busy');
  resolve(jwt(4000));
  await pending;
  const next = manager.refresh(other.options());
  resolve(jwt(4000));
  assert.equal((await next).status, 'refreshed');
});

test('native callback wiring never clears a rejected response slot', () => {
  assert.match(SCRIPT, /delegate int Callback\(IntPtr category,IntPtr content,IntPtr response\)/);
  assert.match(SCRIPT, /callback=RejectHostRequest;/);
  assert.doesNotMatch(SCRIPT, /callback=.*out IntPtr response/);
});

test(
  'native rejection preserves caller-owned reply memory',
  { skip: process.platform !== 'win32' },
  () => {
    const source = SCRIPT.match(/\$src=@'\r?\n([\s\S]*?)\r?\n'@/)[1];
    const script = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${source}
'@
$slot=[Runtime.InteropServices.Marshal]::AllocHGlobal([IntPtr]::Size)
try {
 [Runtime.InteropServices.Marshal]::WriteIntPtr($slot,[IntPtr]1234)
 $code=[TianxiAuthBridge]::RejectHostRequest([IntPtr]::Zero,[IntPtr]::Zero,$slot)
 [Console]::WriteLine(($code -eq 1 -and [Runtime.InteropServices.Marshal]::ReadIntPtr($slot) -eq [IntPtr]1234))
} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($slot) }`;
    const child = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 15000 }
    );
    assert.equal(child.status, 0);
    assert.equal(child.stdout.trim(), 'True');
  }
);
test('native identity change and mismatched claims never enter cache', async () => {
  const f = fixture();
  let calls = 0;
  const manager = createTianxiAuthRefreshManager({
    now: () => 1000000,
    exchange: async () => {
      calls++;
      f.set({ ...f.get(), user_id: 'other-user' });
      return jwt(4000);
    },
  });
  assert.equal((await manager.refresh(f.options())).errorCode, 'tianxi_auth_account_changed');
  const bad = createTianxiAuthRefreshManager({
    now: () => 1000000,
    exchange: async () => jwt(4000, { sub: 'other-sub' }),
  });
  assert.equal((await bad.refresh(f.options())).errorCode, 'tianxi_auth_candidate_invalid');
  assert.equal(calls, 1);
});
test('cancelling one subscriber does not cancel another; cancelling all aborts native work', async () => {
  const f = fixture();
  let resolve, upstream;
  const manager = createTianxiAuthRefreshManager({
    now: () => 1000000,
    exchange: (_, options) => {
      upstream = options.signal;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  const first = new globalThis.AbortController();
  const a = manager.refresh(f.options(), { signal: first.signal });
  const b = manager.refresh(f.options());
  first.abort();
  await assert.rejects(a, /tianxi_auth_aborted/);
  assert.equal(upstream.aborted, false);
  resolve(jwt(4000));
  assert.equal((await b).token, jwt(4000));
  const second = new globalThis.AbortController();
  const c = manager.refresh(
    { ...f.options(), force: true, previousToken: jwt(4000) },
    { signal: second.signal }
  );
  second.abort();
  await assert.rejects(c, /tianxi_auth_aborted/);
  assert.equal(upstream.aborted, true);
  resolve(jwt(4000));
});
test('provider cancellation errors do not create failure backoff', async () => {
  const f = fixture();
  let calls = 0;
  const manager = createTianxiAuthRefreshManager({
    now: () => 1000000,
    exchange: (_, { signal }) => {
      calls++;
      if (calls > 1) return Promise.resolve(jwt(4000));
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('provider private error')), {
          once: true,
        })
      );
    },
  });
  const controller = new globalThis.AbortController();
  const pending = manager.refresh(f.options(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /tianxi_auth_aborted/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await manager.refresh(f.options())).status, 'refreshed');
  assert.equal(calls, 2);
});

test('invalid inputs, stale tokens and unknown subjects fail closed', () => {
  const f = fixture();
  for (const header of [
    null,
    {},
    { ...f.get(), user_id: 'u\n' },
    { ...f.get(), device_id: 'x'.repeat(257) },
  ])
    assert.ok(!validIdentity(header));
  for (const token of [
    null,
    '',
    'sat-secret',
    jwt(1),
    jwt(4000, { sub: 'different' }),
    jwt(4000, { exp: true }),
    jwt(1000000),
  ])
    assert.equal(candidateMatches(token, f.get(), 1000000), false);
  for (const data of [null, Buffer.alloc(0), Buffer.alloc(64)])
    assert.throws(() => peData(data, 1, 2), /tianxi_auth_build_invalid/);
  assert.throws(
    () => loadAuthBuild('app', () => Buffer.from('changed')),
    /tianxi_auth_build_changed/
  );
});
test('exchange uses canonical base fields, rejects redirects and validates returned token', async () => {
  const f = fixture();
  let sent;
  const options = {
    now: () => 1000000,
    loadBuild: () => ({
      endpoint: 'https://owned.example',
      positionId: '14',
      alphabet: 'abc123',
      initPayload: {},
    }),
    native: async (input) => {
      assert.equal(input.canonical.startsWith('appId=owned-app&lenovoId=owned-user&nonce='), true);
      return { token: jwt(4000).slice(4), signature: Buffer.alloc(256).toString('base64') };
    },
    fetchImpl: async (url, input) => {
      sent = input;
      return new globalThis.Response(
        JSON.stringify({ code: 10000, accessToken: jwt(4000), expiresIn: 3000 })
      );
    },
  };
  assert.equal(await exchangeTianxiToken(f.get(), options), jwt(4000));
  for (const reply of [
    null,
    {},
    { token: jwt(4000).slice(4) + '\r\nsecret', signature: Buffer.alloc(256).toString('base64') },
    { token: jwt(1000000).slice(4), signature: Buffer.alloc(256).toString('base64') },
  ]) {
    await assert.rejects(
      exchangeTianxiToken(f.get(), {
        ...options,
        native: async () => reply,
        fetchImpl: async () => {
          throw new Error('must not fetch');
        },
      }),
      /tianxi_auth_native_reply_invalid/
    );
  }
  assert.equal(sent.redirect, 'error');
  assert.equal(Object.keys(JSON.parse(sent.body)).length, 7);
  for (const response of [
    new globalThis.Response('{}', { status: 400 }),
    new globalThis.Response('{'),
    new globalThis.Response(JSON.stringify({ code: 500, msg: 'private-error' })),
    new globalThis.Response(
      JSON.stringify({ code: 10000, accessToken: jwt(4000, { sub: 'other' }), expiresIn: 3000 })
    ),
    new globalThis.Response('x'.repeat(65537)),
  ])
    await assert.rejects(
      exchangeTianxiToken(f.get(), { ...options, fetchImpl: async () => response }),
      /^Error: tianxi_auth_/
    );
});
test('isolated native helper handles launch failure and bounds pipe output', async () => {
  const fake = () => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    return child;
  };
  for (const fail of [
    (child) => child.emit('error', new Error('private')),
    (child) => child.stdout.emit('data', Buffer.alloc(40001)),
    (child) => child.emit('close', 1),
  ]) {
    const child = fake();
    const promise = invokeNative({}, undefined, () => child);
    fail(child);
    await assert.rejects(promise, /^Error: tianxi_auth_native_failed$/);
  }
});
test('production token refresh selects no-chat callback without opening UI', async () => {
  let ui = 0,
    calls = 0;
  const result = await refreshTianxiQoderToken({
    readCache: () => ({}),
    programmaticRefresh: async () => {
      calls++;
      return { status: 'refreshed', source: 'native-exchange' };
    },
    triggerNativeRefresh: async () => {
      ui++;
    },
  });
  assert.equal(result.source, 'native-exchange');
  assert.equal(calls, 1);
  assert.equal(ui, 0);
});
