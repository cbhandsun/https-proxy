'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { buildLocalEvidencePlugin } = require('../scripts/build-local-evidence-plugin');
const { protectedConfig } = require('../scripts/install-local-evidence-plugin');
const { prepareLocalEvidencePlugin } = require('../scripts/prepare-local-evidence-plugin');
const {
  readGeneratedPluginModules,
  retireGeneratedPluginModules,
} = require('../scripts/lib/local-evidence-plugin-stale');
const { createLegacyPluginFixture } = require('./helpers/legacy-plugin-fixture');
const root = path.resolve(__dirname, '..');
const plugin = path.join(root, 'plugins/hpm-local-evidence');
const read = (file) => JSON.parse(fs.readFileSync(path.join(plugin, file), 'utf8'));

test('legacy fixture builds from clean sources without copying ignored state or changing source bytes', (t) => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-plugin-fixture-source-'));
  t.after(() => {
    assert.equal(path.dirname(source), path.resolve(os.tmpdir()));
    assert.ok(path.basename(source).startsWith('hpm-plugin-fixture-source-'));
    fs.rmSync(source, { recursive: true, force: true });
  });
  const put = (relative, text) => {
    const file = path.join(source, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  for (const name of [
    '.codex-plugin/plugin.json',
    '.mcp.json',
    'hooks/hooks.json',
    'mcp.json',
    'package.json',
    'package-lock.json',
    'plugin.portable.json',
    'server.cjs',
  ])
    put('plugins/hpm-local-evidence/' + name, fs.readFileSync(path.join(plugin, name)));
  put('lib/client/context-evidence-mcp.js', "require('./empty');\n");
  put('lib/client/empty.js', '');
  const snapshot = () =>
    fs
      .readdirSync(source, { recursive: true })
      .filter((name) => fs.statSync(path.join(source, name)).isFile())
      .sort()
      .map((name) => [
        name,
        createHash('sha256')
          .update(fs.readFileSync(path.join(source, name)))
          .digest('hex'),
      ]);
  const cleanSource = snapshot();
  assert.throws(
    () => fs.readFileSync(path.join(source, 'plugins/hpm-local-evidence/runtime-manifest.json')),
    { code: 'ENOENT' }
  );
  assert.throws(
    () =>
      require.resolve(
        path.join(source, 'plugins/hpm-local-evidence/runtime/lib/client/context-evidence-mcp')
      ),
    { code: 'MODULE_NOT_FOUND' }
  );
  const first = createLegacyPluginFixture(t, source);
  assert.deepEqual(snapshot(), cleanSource);
  assert.equal(first.read('runtime-manifest.json').files.length, 2);
  assert.equal(fs.existsSync(path.join(source, 'plugins/hpm-local-evidence/runtime')), false);
  put('plugins/hpm-local-evidence/runtime/poison.js', 'must remain source-only');
  put('plugins/hpm-local-evidence/runtime-manifest.json', 'invalid stale source manifest');
  put('plugins/hpm-local-evidence/node_modules/poison.js', 'must not be copied');
  const staleSource = snapshot();
  const second = createLegacyPluginFixture(t, source);
  assert.deepEqual(snapshot(), staleSource);
  assert.notEqual(first.root, second.root);
  assert.equal(second.read('runtime-manifest.json').files.length, 2);
  assert.equal(fs.existsSync(path.join(second.plugin, 'runtime/poison.js')), false);
  assert.equal(fs.existsSync(path.join(second.plugin, 'node_modules')), false);
  assert.equal(
    fs.readFileSync(path.join(source, 'plugins/hpm-local-evidence/runtime-manifest.json'), 'utf8'),
    'invalid stale source manifest'
  );
  put('lib/client/context-evidence-mcp.js', "require('unapproved-external-package');\n");
  assert.throws(() => createLegacyPluginFixture(t, source), /plugin_fixture_dependency_refused/);
  put('lib/client/context-evidence-mcp.js', "require('../../outside');\n");
  put('outside.js', '');
  assert.throws(() => createLegacyPluginFixture(t, source), /plugin_fixture_source_refused/);
  fs.unlinkSync(path.join(source, 'lib/client/context-evidence-mcp.js'));
  assert.throws(() => createLegacyPluginFixture(t, source), { code: 'ENOENT' });
});

test('staged plugin ships the current complete source closure with consistent package identities', (t) => {
  const { plugin, read } = createLegacyPluginFixture(t, root);
  assert.equal(fs.existsSync(path.join(plugin, 'node_modules')), false);
  const manifest = read('runtime-manifest.json');
  assert.equal(manifest.schema, 'hpm.context.plugin-closure');
  const paths = new Set(manifest.files.map((entry) => entry.path));
  const shippedFiles = fs
    .readdirSync(path.join(plugin, 'runtime'), { recursive: true })
    .filter((file) => file.endsWith('.js'))
    .map((file) => file.replace(/\\/g, '/'));
  assert.deepEqual(shippedFiles.sort(), [...paths].sort());
  assert.equal(paths.size, manifest.files.length);
  assert.equal(paths.has('lib/client/context-evidence-mcp.js'), true);
  for (const entry of manifest.files) {
    assert.match(entry.path, /^lib\/[A-Za-z0-9_./-]+\.js$/);
    assert.equal(entry.path.includes('..'), false);
    const current = fs.readFileSync(path.join(root, entry.path));
    const shipped = fs.readFileSync(path.join(plugin, 'runtime', entry.path));
    assert.equal(createHash('sha256').update(shipped).digest('hex'), entry.sha256);
    assert.deepEqual(shipped, current, entry.path);
    for (const match of current.toString('utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      if (!match[1].startsWith('.')) continue;
      const resolved = require.resolve(path.resolve(root, path.dirname(entry.path), match[1]));
      const relative = path.relative(root, resolved).replace(/\\/g, '/');
      assert.equal(paths.has(relative), true, relative);
    }
  }
  const version = read('package.json').version;
  assert.equal(read('.codex-plugin/plugin.json').version, version);
  assert.equal(read('plugin.portable.json').version, version);
  assert.equal(read('package-lock.json').version, version);
  assert.equal(read('package-lock.json').packages[''].version, version);
});

test('staged plugin stdio handshake and exact evidence read use the shipped entrypoint', async (t) => {
  const resources = {};
  t.after(async () => {
    await resources.client?.close();
    await resources.transport?.close();
  });
  const { plugin, read, preload } = createLegacyPluginFixture(t, root);
  const client = new Client({ name: 'synthetic-package-verification', version: '1.0.0' });
  resources.client = client;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--require', preload, './server.cjs'],
    cwd: plugin,
    env: {},
    stderr: 'pipe',
  });
  resources.transport = transport;
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, read('package.json').version);
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(tools, ['hpm_list_retained_evidence', 'hpm_read_retained_evidence']);
  const call = (name, args, thread = 'synthetic-package-thread') =>
    client.callTool({ name, arguments: args, _meta: { threadId: thread } });
  const text = 'synthetic package\r\n精确原文🙂';
  const captured = await call('hpm_capture_completed_hook', {
    hook_event_name: 'PostToolUse',
    session_id: 'synthetic-package-thread',
    tool_use_id: 'synthetic-package-call',
    tool_name: 'synthetic_package_tool',
    tool_input: {},
    tool_response: text,
  });
  assert.deepEqual(captured.content, [{ type: 'text', text: '{}' }]);
  const listed = JSON.parse((await call('hpm_list_retained_evidence', {})).content[0].text);
  assert.equal(listed.sources.length, 1);
  const { sourceId, digest } = listed.sources[0];
  const readback = await call('hpm_read_retained_evidence', { sourceId, digest });
  assert.equal(JSON.parse(readback.content[0].text).page.text, text);
  assert.equal(
    (await call('hpm_list_retained_evidence', {}, 'foreign-package-thread')).isError,
    true
  );
});

test(
  'active staged plugin releases its disposable cache and serves exact evidence after the entire package is removed',
  { timeout: 60000 },
  async (t) => {
    const started = Date.now();
    const artifact = await prepareLocalEvidencePlugin(root);
    const preparedAt = Date.now();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-plugin-cache-removal-'));
    const disposable = path.join(directory, 'package');
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('hpm-plugin-cache-removal-'));
    const client = new Client({ name: 'synthetic-cache-removal', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['./server.cjs'],
      cwd: disposable,
      env: {},
      stderr: 'pipe',
    });
    let copyMs, removeMs;
    try {
      const copyStarted = Date.now();
      fs.cpSync(artifact.packageDirectory, disposable, { recursive: true });
      copyMs = Date.now() - copyStarted;
      await client.connect(transport);
      const call = (name, args, thread = 'cache-removal-thread') =>
        client.callTool({ name, arguments: args, _meta: { threadId: thread } });
      const capture = (id, text) =>
        call('hpm_capture_completed_hook', {
          hook_event_name: 'PostToolUse',
          session_id: 'cache-removal-thread',
          tool_use_id: id,
          tool_name: 'synthetic_tool',
          tool_input: {},
          tool_response: text,
        });
      const original = 'cache removal\r\n精确原文🙂';
      await capture('before-removal', original);
      const before = JSON.parse((await call('hpm_list_retained_evidence', {})).content[0].text)
        .sources[0];
      assert.ok(Number.isSafeInteger(before.expiresAt));
      assert.equal(path.dirname(path.resolve(disposable)), path.resolve(directory));
      const removeStarted = Date.now();
      fs.rmSync(disposable, { recursive: true });
      removeMs = Date.now() - removeStarted;
      assert.equal(fs.existsSync(disposable), false);
      const readback = JSON.parse(
        (
          await call('hpm_read_retained_evidence', {
            sourceId: before.sourceId,
            digest: before.digest,
          })
        ).content[0].text
      );
      assert.equal(readback.page.text, original);
      await capture('after-removal', 'new exact\r\n🙂');
      const after = JSON.parse((await call('hpm_list_retained_evidence', {})).content[0].text);
      assert.equal(after.sources.length, 2);
      const retained = after.sources.find((item) => item.sourceId === before.sourceId);
      assert.equal(retained.expiresAt, before.expiresAt);
      assert.equal((await call('hpm_list_retained_evidence', {}, 'foreign-thread')).isError, true);
      t.diagnostic(
        JSON.stringify({
          scope: 'complete-installer-package-cache-removal',
          fileCount: artifact.fileCount,
          packageBytes: artifact.bytes,
          prepareMs: preparedAt - started,
          copyMs,
          removeMs,
        })
      );
    } finally {
      await client.close();
      await transport.close();
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('hpm-plugin-cache-removal-'));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);

test('packaged compatibility manifest and optional policy example work without local Codex activation state', () => {
  const manifest = read('.codex-plugin/plugin.json');
  assert.equal(fs.existsSync(path.join(plugin, 'plugin.json')), false);
  assert.equal(manifest.mcpServers, './.mcp.json');
  const config = read('.mcp.json');
  assert.deepEqual(config.mcpServers.evidence, {
    cwd: '.',
    command: 'node',
    args: ['./server.cjs'],
  });
  const hooks = read('hooks/hooks.json');
  assert.deepEqual(Object.keys(hooks.hooks), ['PostToolUse']);
  const handler = hooks.hooks.PostToolUse[0].hooks[0];
  assert.equal(handler.type, 'mcp_tool');
  assert.equal(handler.timeout, 3);
  assert.equal(Object.hasOwn(handler.input, 'transcript_path'), false);
  assert.equal(Object.hasOwn(handler, 'additionalContext'), false);
  assert.equal(read('package.json').dependencies['@modelcontextprotocol/sdk'], '1.32.1');
  assert.equal(
    read('package-lock.json').packages['node_modules/@modelcontextprotocol/sdk'].version,
    '1.32.1'
  );
  // This distributable example is available in a clean checkout. It is not
  // evidence that a native client has installed or activated the plugin;
  // actual local policy remains part of separate installed-client acceptance.
  const policy = fs.readFileSync(path.join(root, 'examples/local-evidence-codex.toml'), 'utf8');
  const activePolicyLines = policy
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(activePolicyLines, [
    '[plugins."hpm-local-evidence@hpm-local"]',
    'enabled = true',
    '[plugins."hpm-local-evidence@hpm-local".mcp_servers.evidence]',
    'enabled = true',
    'enabled_tools = ["hpm_list_retained_evidence", "hpm_read_retained_evidence", "hpm_capture_completed_hook"]',
  ]);
  assert.ok(
    policy.includes(
      'enabled_tools = ["hpm_list_retained_evidence", "hpm_read_retained_evidence", "hpm_capture_completed_hook"]'
    )
  );
  assert.equal(
    /(?:model|model_provider|provider|base_url|authentication|api_key|auth_token|access_token)\s*=/.test(
      policy
    ),
    false
  );
  assert.equal(/(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)/.test(policy), false);
});

test('package builder generates a local closure and rejects external undeclared or escaping modules', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-plugin-build-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temp, 'lib/client'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'plugins/hpm-local-evidence'), { recursive: true });
  const modulePath = path.join(temp, 'lib/client/context-evidence-mcp.js');
  fs.writeFileSync(modulePath, "module.exports = require('node:crypto');\n");
  assert.equal(buildLocalEvidencePlugin(temp).moduleCount, 1);
  const manifestText = fs.readFileSync(
    path.join(temp, 'plugins/hpm-local-evidence/runtime-manifest.json'),
    'utf8'
  );
  assert.ok(manifestText.endsWith('\r\n'));
  assert.equal(/(^|[^\r])\n/.test(manifestText), false);
  const manifest = JSON.parse(manifestText);
  const bytes = fs.readFileSync(modulePath);
  assert.equal(manifest.files[0].sha256, createHash('sha256').update(bytes).digest('hex'));
  fs.writeFileSync(modulePath, "module.exports = require('undeclared-package');\n");
  assert.throws(() => buildLocalEvidencePlugin(temp), /undeclared/);
  fs.writeFileSync(path.join(temp, 'outside.js'), 'module.exports = {};');
  fs.writeFileSync(modulePath, "module.exports = require('../../outside');\n");
  assert.throws(() => buildLocalEvidencePlugin(temp), /boundary/);
});

test('builder retires only unchanged modules from its previous generated manifest', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-plugin-retirement-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'lib/client');
  const output = path.join(temp, 'plugins/hpm-local-evidence');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const entry = path.join(source, 'context-evidence-mcp.js');
  fs.writeFileSync(entry, "module.exports = require('./retired');\n");
  fs.writeFileSync(path.join(source, 'retired.js'), 'module.exports = 1;\n');
  assert.equal(buildLocalEvidencePlugin(temp).moduleCount, 2);
  const retired = path.join(output, 'runtime/lib/client/retired.js');
  const userFile = path.join(output, 'runtime/user-owned.txt');
  fs.writeFileSync(userFile, 'preserved');
  fs.writeFileSync(entry, 'module.exports = 2;\n');
  fs.writeFileSync(retired, 'user edit');
  assert.throws(() => buildLocalEvidencePlugin(temp), /generated module boundary/);
  assert.equal(fs.readFileSync(retired, 'utf8'), 'user edit');
  fs.writeFileSync(retired, 'module.exports = 1;\n');
  assert.equal(buildLocalEvidencePlugin(temp).moduleCount, 1);
  assert.equal(fs.existsSync(retired), false);
  assert.equal(fs.readFileSync(userFile, 'utf8'), 'preserved');
  assert.equal(buildLocalEvidencePlugin(temp).moduleCount, 1);
});

test('previous plugin manifests reject malformed, unsafe and extreme module declarations', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-plugin-manifest-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'runtime-manifest.json');
  const entry = { path: 'lib/client/retired.js', sha256: 'a'.repeat(64) };
  const manifest = (files) => ({ schema: 'hpm.context.plugin-closure', version: 1, files });
  assert.deepEqual(readGeneratedPluginModules(temp), []);
  for (const value of [
    null,
    {},
    manifest(null),
    manifest([null]),
    manifest([{}]),
    manifest([{ ...entry, path: '../outside.js' }]),
    manifest([{ ...entry, path: '/lib/outside.js' }]),
    manifest([{ ...entry, path: 'lib/a/../outside.js' }]),
    manifest([{ ...entry, path: 'lib/' + 'a'.repeat(1024) + '.js' }]),
    manifest([{ ...entry, sha256: 'wrong' }]),
    manifest([{ ...entry, sha256: 1 }]),
    manifest([entry, entry]),
    manifest(Array(513).fill(entry)),
  ]) {
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(() => readGeneratedPluginModules(temp), /generated module boundary/);
  }
  fs.writeFileSync(file, '{');
  assert.throws(() => readGeneratedPluginModules(temp), SyntaxError);
  fs.writeFileSync(file, ' '.repeat(256 * 1024 + 1));
  assert.throws(() => readGeneratedPluginModules(temp), /generated module boundary/);
  fs.writeFileSync(file, JSON.stringify(manifest([])));
  assert.deepEqual(readGeneratedPluginModules(temp), []);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => readGeneratedPluginModules(temp), /generated module boundary/);
});

test('manifest and retirement filesystem failures propagate without a compatibility fallback', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-plugin-read-failure-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const runtime = path.join(temp, 'runtime');
  const manifest = path.join(temp, 'runtime-manifest.json');
  const original = fs.lstatSync;
  const sentinel = Object.assign(new Error('synthetic_permission_failure'), { code: 'EACCES' });
  try {
    fs.lstatSync = (file, ...options) => {
      if (file === runtime || file === manifest) throw sentinel;
      return original(file, ...options);
    };
    assert.throws(
      () => readGeneratedPluginModules(temp),
      (error) => error === sentinel
    );
    assert.throws(
      () =>
        retireGeneratedPluginModules(
          runtime,
          [{ path: 'lib/client/retired.js', sha256: 'a'.repeat(64) }],
          new Set()
        ),
      (error) => error === sentinel
    );
  } finally {
    fs.lstatSync = original;
  }
});

test('retirement validates every candidate and refuses linked paths without removing other files', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-plugin-linked-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const runtime = path.join(temp, 'runtime');
  const directory = path.join(runtime, 'lib/client');
  fs.mkdirSync(directory, { recursive: true });
  const text = 'synthetic stale module';
  const digest = createHash('sha256').update(text).digest('hex');
  const entry = (name) => ({ path: 'lib/client/' + name + '.js', sha256: digest });
  fs.writeFileSync(path.join(directory, 'first.js'), text);
  fs.writeFileSync(path.join(directory, 'changed.js'), 'user change');
  assert.throws(
    () => retireGeneratedPluginModules(runtime, [entry('first'), entry('changed')], new Set()),
    /generated module boundary/
  );
  assert.equal(fs.existsSync(path.join(directory, 'first.js')), true);
  fs.linkSync(path.join(directory, 'first.js'), path.join(directory, 'linked.js'));
  assert.throws(
    () => retireGeneratedPluginModules(runtime, [entry('linked')], new Set()),
    /generated module boundary/
  );
  fs.unlinkSync(path.join(directory, 'linked.js'));
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'module.js'), text);
  fs.symlinkSync(
    outside,
    path.join(runtime, 'lib/linked'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  assert.throws(
    () =>
      retireGeneratedPluginModules(
        runtime,
        [{ path: 'lib/linked/module.js', sha256: digest }],
        new Set()
      ),
    /generated module boundary/
  );
  assert.equal(fs.readFileSync(path.join(outside, 'module.js'), 'utf8'), text);
  assert.equal(retireGeneratedPluginModules(runtime, [entry('missing')], new Set()), 0);
  assert.equal(
    retireGeneratedPluginModules(runtime, [entry('first')], new Set([entry('first').path])),
    0
  );
  assert.equal(retireGeneratedPluginModules(runtime, [entry('first')], new Set()), 1);
});

test('configuration integrity excludes only this plugin registration, never model or authentication changes', () => {
  const original = 'model="unchanged"\n[model_providers.custom]\nbase_url="unchanged"\n';
  const registered =
    original +
    '\n[marketplaces.hpm-local]\nsource="local"\n\n[plugins."hpm-local-evidence@hpm-local"]\nenabled=true\n';
  assert.equal(protectedConfig(registered), protectedConfig(original));
  assert.equal(
    protectedConfig(
      registered +
        '\n[hooks.state]\n\n[hooks.state."hpm-local-evidence@hpm-local:hooks/hooks.json:post_tool_use:0:0"]\ntrusted_hash="synthetic"\n'
    ),
    protectedConfig(original)
  );
  assert.notEqual(
    protectedConfig(registered.replace('model="unchanged"', 'model="changed"')),
    protectedConfig(original)
  );
  assert.notEqual(
    protectedConfig(registered + '\n[model_providers.other]\napi_key="synthetic"\n'),
    protectedConfig(original)
  );
});
