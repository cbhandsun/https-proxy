'use strict';
const test = require('node:test');
const { Response } = globalThis;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const {
  IDENTITY: id,
  NODE_URL,
  assertRelease,
  receiveLegacyRuntime,
} = require('../scripts/lib/legacy-runtime-transfer');
const release = () => ({
  id: id.release,
  draft: true,
  published_at: null,
  tag_name: id.tag,
  target_commitish: id.target,
  author: { login: 'cbhandsun' },
  assets: [
    {
      id: id.asset,
      name: id.name,
      size: id.size,
      state: 'uploaded',
      digest: `sha256:${id.archive}`,
    },
  ],
});
const safe = (error) =>
  error.message === 'legacy_runtime_transfer_refused' && error.cause === undefined;
function fixture(t, mode = '') {
  const root = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'hpm-582-receive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'current'));
  const env = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows',
    GITHUB_REPOSITORY: 'cbhandsun/https-proxy',
    GITHUB_API_URL: 'https://api.github.com',
    GH_TOKEN: 'synthetic-private-token',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKSPACE: root,
  };
  let checks = 0,
    probes = 0;
  const calls = [];
  const dependencies = {
    checkoutCommit: () => (mode === 'checkout' ? 'b'.repeat(40) : env.GITHUB_SHA),
    metadata(route) {
      if (!route)
        return {
          full_name: env.GITHUB_REPOSITORY,
          private: false,
          owner: { login: 'cbhandsun' },
          archived: false,
          disabled: false,
        };
      checks++;
      const value = release();
      if (mode === 'published' || (mode === 'published-after' && checks > 1)) value.draft = false;
      if (mode === 'asset') value.assets[0].digest = 'sha256:' + '0'.repeat(64);
      return value;
    },
    digest(file) {
      assert.equal(path.dirname(file), path.join(root, 'legacy-582-transfer'));
      return mode === 'digest' ? '0'.repeat(64) : file.endsWith('node.exe') ? id.node : id.archive;
    },
    async fetch(url, options) {
      calls.push({ url, options });
      if (url === NODE_URL) {
        assert.deepEqual(options.headers, { accept: 'application/octet-stream' });
        assert.equal(options.redirect, 'error');
        if (mode === 'node-redirect') return new Response(null, { status: 302 });
        return new Response(Buffer.alloc(32), {
          headers: mode === 'node-overflow' ? { 'content-length': '104857601' } : {},
        });
      }
      if (options.headers.authorization) {
        assert.equal(options.headers.authorization, 'Bearer synthetic-private-token');
        assert.ok(url.endsWith('/' + id.asset));
        return new Response(Buffer.alloc(mode === 'truncated' ? 1 : id.size));
      }
      probes++;
      assert.deepEqual(Object.keys(options.headers), ['accept']);
      assert.equal(options.redirect, 'manual');
      if (mode === 'network') throw Error('synthetic-private-token');
      return new Response(null, {
        status: mode === 'visible' || (mode === 'visible-after' && probes > 4) ? 302 : 404,
      });
    },
  };
  return { root, env, dependencies, calls };
}
test('582 receiver pins old release separately from current checkout, bounds bytes and keeps official Node unauthenticated', async (t) => {
  const f = fixture(t);
  const directory = await receiveLegacyRuntime(f.env, f.dependencies);
  assert.equal(directory, path.join(f.root, 'legacy-582-transfer'));
  assert.equal(fs.statSync(path.join(directory, id.name)).size, id.size);
  assert.equal(f.calls.filter((x) => x.url === NODE_URL).length, 1);
  assert.equal(
    f.calls.filter((x) => !x.options.headers.authorization && x.url !== NODE_URL).length,
    8
  );
  await assert.rejects(receiveLegacyRuntime(f.env, f.dependencies), safe);
});
for (const mode of [
  'checkout',
  'published',
  'published-after',
  'asset',
  'digest',
  'truncated',
  'node-redirect',
  'node-overflow',
  'visible',
  'visible-after',
  'network',
]) {
  test('582 receiver refuses ' + mode + ' without retry or private diagnostics', async (t) => {
    const f = fixture(t, mode);
    await assert.rejects(receiveLegacyRuntime(f.env, f.dependencies), safe);
    assert.ok(f.calls.filter((x) => x.options.headers.authorization).length <= 1);
  });
}
test('582 receiver rejects empty, illegal and hostile execution environments before I/O', async (t) => {
  const f = fixture(t);
  for (const env of [
    null,
    {},
    { ...f.env, RUNNER_OS: 'Linux' },
    { ...f.env, RUNNER_ENVIRONMENT: 'self-hosted' },
    { ...f.env, GH_TOKEN: '' },
    { ...f.env, GH_TOKEN: '\n' },
    { ...f.env, GH_TOKEN: 'x'.repeat(4097) },
    { ...f.env, GITHUB_SHA: 'x' },
    { ...f.env, GITHUB_API_URL: 'https://untrusted.invalid' },
  ]) {
    await assert.rejects(receiveLegacyRuntime(env, f.dependencies), safe);
  }
  let reads = 0;
  const hostile = Object.defineProperty({ ...f.env }, 'GITHUB_ACTIONS', {
    enumerable: true,
    get() {
      reads++;
      throw Error('private');
    },
  });
  await assert.rejects(receiveLegacyRuntime(hostile, f.dependencies), safe);
  await assert.rejects(
    receiveLegacyRuntime(
      new Proxy(
        {},
        {
          get() {
            reads++;
            return undefined;
          },
        }
      ),
      f.dependencies
    ),
    safe
  );
  assert.equal(reads, 0);
  assert.equal(f.calls.length, 0);
});
test('582 release rejects missing, changed, extra and getter-backed identity fields', () => {
  assert.doesNotThrow(() => assertRelease(release()));
  for (const change of [
    (v) => {
      v.id++;
    },
    (v) => {
      v.published_at = 'now';
    },
    (v) => {
      v.target_commitish = 'b'.repeat(40);
    },
    (v) => {
      v.author.login = 'other';
    },
    (v) => {
      v.assets.push({});
    },
    (v) => {
      v.assets = [];
    },
    (v) => {
      v.assets[0].size = Number.MAX_SAFE_INTEGER;
    },
    (v) => {
      v.assets[0].name = '../payload';
    },
    (v) => {
      v.tag_name = '';
    },
  ]) {
    const value = release();
    change(value);
    assert.throws(() => assertRelease(value), safe);
  }
  let reads = 0;
  const value = Object.defineProperty(release(), 'draft', {
    enumerable: true,
    get() {
      reads++;
      return undefined;
    },
  });
  assert.throws(() => assertRelease(value), safe);
  assert.throws(
    () =>
      assertRelease(
        new Proxy(
          {},
          {
            get() {
              reads++;
              return undefined;
            },
          }
        )
      ),
    safe
  );
  assert.equal(reads, 0);
});
