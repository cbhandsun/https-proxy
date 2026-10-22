'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const {
  compileTianxiClientRead,
  tianxiClientReadMetadata,
  tianxiClientCommandInput,
  tianxiClientArgumentFailure,
} = require('../lib/proxy/tianxi-client-read-tools');
const { discoverTestFiles, selectUnitTestFiles } = require('../lib/test-discovery');
const { createTianxiClientToolSessions } = require('../lib/proxy/tianxi-client-tool-sessions');

const action = (name, parameters) => ({ mcpServerName: 'codex_readonly', name, parameters });
const fakeFs = {
  realpathSync: { native: (value) => path.win32.normalize(value) },
  existsSync: () => true,
  statSync: () => ({ isFile: () => true, isDirectory: () => true }),
};
const compile = (name, args) => compileTianxiClientRead(action(name, args), 'C:\\repo', fakeFs);

test('read/search options are advertised with bounded, explicit semantics', () => {
  const definitions = tianxiClientReadMetadata({ disallowedTools: [] }).options.customMcpServers
    .codex_readonly.tools;
  const read = definitions.find((tool) => tool.name === 'read_file');
  assert.deepEqual(read.inputSchema.properties.tail, {
    type: 'integer',
    minimum: 1,
    maximum: 2000,
  });
  assert.equal(read.inputSchema.properties.include_metadata.type, 'boolean');
  for (const name of ['find_files', 'search_text']) {
    const tool = definitions.find((item) => item.name === name);
    assert.equal(tool.inputSchema.properties.include_hidden.type, 'boolean');
    assert.equal(tool.inputSchema.properties.include_ignored.type, 'boolean');
    assert.match(tool.description, /absence/);
  }
  assert.ok(
    selectUnitTestFiles(discoverTestFiles(path.resolve(__dirname, '..'))).includes(
      'test/tianxi-client-read-options.test.js'
    )
  );
});

test('tail and metadata reject malformed, incompatible and extreme arguments', () => {
  for (const tail of [0, -1, 2001, 1.5, '10', null, true, {}, Number.MAX_SAFE_INTEGER])
    assert.throws(
      () => compile('read_file', { file_path: 'probe.txt', tail }),
      /arguments_invalid/
    );
  for (const key of ['offset', 'limit'])
    assert.throws(
      () => compile('read_file', { file_path: 'probe.txt', tail: 1, [key]: 1 }),
      /arguments_invalid/
    );
  for (const tail of [1, 2000])
    assert.doesNotThrow(() =>
      compile('read_file', { file_path: 'probe.txt', tail, include_metadata: true })
    );
  for (const value of [null, 'true', 0, {}, []]) {
    assert.throws(
      () => compile('read_file', { file_path: 'probe.txt', include_metadata: value }),
      /arguments_invalid/
    );
    for (const name of ['find_files', 'search_text'])
      for (const key of ['include_hidden', 'include_ignored'])
        assert.throws(
          () => compile(name, { pattern: '*', path: 'logs', [key]: value }),
          /arguments_invalid/
        );
  }
  assert.throws(
    () => compile('read_file', { file_path: '../escape.txt', tail: 20 }),
    /arguments_invalid/
  );
});

test('ignored discovery requires a physical sub-scope and preserves exclusion precedence', () => {
  for (const name of ['find_files', 'search_text']) {
    for (const scope of [undefined, '.', './logs/..', 'C:\\repo']) {
      const args = { pattern: '*', include_ignored: true };
      if (scope !== undefined) args.path = scope;
      let failure;
      try {
        compile(name, args);
      } catch (error) {
        failure = tianxiClientArgumentFailure(error);
      }
      assert.equal(failure.reason, 'ignored_scope');
    }
    for (const scope of [
      'node_modules',
      '.git',
      '.env',
      'logs/.env.local',
      'logs/secret.pem',
      'logs/secret.key',
    ])
      assert.throws(
        () =>
          compile(name, { pattern: '*', path: scope, include_hidden: true, include_ignored: true }),
        /arguments_invalid/
      );
    assert.throws(
      () => compile(name, { pattern: '*', path: '../outside', include_ignored: true }),
      /arguments_invalid/
    );
  }
  const command = compile('find_files', {
    pattern: '**/*',
    path: 'logs',
    include_ignored: true,
  }).cmd;
  assert.ok(command.indexOf("--glob '**/*'") < command.indexOf("--glob '!**/.env'"));
  assert.match(command, /--no-ignore/);
  assert.ok(!compile('find_files', { pattern: '*' }).cmd.includes('--no-ignore'));
  const linkedFs = {
    ...fakeFs,
    realpathSync: { native: (value) => (value.endsWith('link') ? 'C:\\outside' : value) },
  };
  assert.throws(
    () =>
      compileTianxiClientRead(
        action('find_files', { pattern: '*', path: 'link', include_ignored: true }),
        'C:\\repo',
        linkedFs
      ),
    /arguments_invalid/
  );
});

test('client wrapper makes transport truncation explicit without changing complete output', async () => {
  for (const original_token_count of [undefined, 10, 2000, 2001, 100000]) {
    const emitted = [];
    await vm.runInNewContext(
      '(async () => {\n' + tianxiClientCommandInput({ cmd: 'fixed' }) + '\n})()',
      {
        tools: {
          exec_command: async () => ({ output: 'observed', exit_code: 0, original_token_count }),
        },
        text: (value) => emitted.push(value),
      }
    );
    assert.equal(emitted[0], 'observed');
    assert.equal(emitted.length, original_token_count > 2000 ? 2 : 1);
    if (emitted.length === 2) assert.match(emitted[1], /not evidence of absence/);
  }
});

test('new safe argument mistakes can be corrected in the same task without executing rejected tools', async () => {
  for (const [name, args, reason] of [
    ['read_file', { file_path: 'probe.txt', tail: 0 }, 'read_tail'],
    ['read_file', { file_path: 'probe.txt', include_metadata: 'true' }, 'option_type'],
    ['find_files', { pattern: '*', include_ignored: true }, 'ignored_scope'],
  ]) {
    const corrections = [];
    const manager = createTianxiClientToolSessions({
      compile: (value) => compile(value.name, value.parameters),
    });
    try {
      const lease = manager.start({
        owner: 'probe',
        model: 'tianxi/super',
        payload: {},
        nativeTools: { cwd: 'C:\\repo', disallowedTools: [] },
        async run(_, context) {
          context.onExternalToolCall({ data: { actions: [action(name, args)] } }, (values) => {
            corrections.push(JSON.parse(values[0]));
            return true;
          });
          await new Promise((resolve) =>
            context.onExternalToolCall(
              { data: { actions: [action('read_file', { file_path: 'probe.txt', tail: 1 })] } },
              () => {
                resolve();
                return true;
              }
            )
          );
          return {
            frames: [
              { type: 'task_output', data: { content_type: 'text', content: 'done' } },
              { type: 'task_status', data: { status: 'COMPLETED' } },
            ],
          };
        },
      });
      const first = await lease.promise;
      const calls = first.output.filter((item) => item.type === 'custom_tool_call');
      assert.equal(calls.length, 1);
      assert.match(calls[0].input, /-Tail 1/);
      assert.equal(corrections.length, 1);
      assert.equal(corrections[0].error.reason, reason);
      const continuation = manager.resume('probe', [
        { type: 'custom_tool_call_output', call_id: calls[0].call_id, output: 'observed' },
      ]);
      assert.equal((await continuation.promise).status, 'completed');
    } finally {
      manager.close();
    }
  }
});

test(
  'real PowerShell/rg read and discovery cover hidden, ignored, empty, malformed and failure paths',
  { skip: process.platform !== 'win32' },
  async () => {
    const { rgPath } = await import('@vscode/ripgrep');
    const commandEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH')
    );
    commandEnv.PATH = path.dirname(rgPath);
    const version = spawnSync(rgPath, ['--version'], {
      env: commandEnv,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.ifError(version.error);
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /^ripgrep /);
    commandEnv.PATH += path.delimiter + (process.env.PATH || process.env.Path || '');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tianxi-read-options-'));
    const write = (relative, value) => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value, 'utf8');
    };
    const run = (name, args, expectedExit = 0) => {
      const compiled = compileTianxiClientRead(action(name, args), root);
      const result = spawnSync(
        compiled.shell,
        ['-NoProfile', '-NonInteractive', '-Command', compiled.cmd],
        {
          cwd: compiled.workdir,
          env: commandEnv,
          windowsHide: true,
          encoding: 'utf8',
          timeout: 15000,
        }
      );
      assert.ifError(result.error);
      assert.equal(result.status, expectedExit, result.stderr);
      return result.stdout.trim();
    };
    try {
      write('.ignore', '*.log\nnode_modules/\n');
      write('.github/workflows/ci.yml', 'fixture-check');
      write("logs/probe 'quoted'.log", 'first\nsecond\nthird\n');
      write('logs/empty.txt', '');
      write('logs/unicode.txt', '中文\n"quoted"\n$() ; escape\n');
      write('logs/.github/workflows/sub.yml', 'nested-fixture');
      write('logs/node_modules/dependency.txt', 'fixture-check');
      write('logs/.git/config', 'fixture-check');
      write('logs/.env.local', 'fixture-check');
      write('logs/.ENV.SECRET', 'fixture-check');
      write('logs/UPPER.KEY', 'fixture-check');
      write('logs/secret.pem', 'fixture-check');
      write('logs/secret.key', 'fixture-check');
      assert.equal(run('find_files', { pattern: '.github/**' }), '');
      assert.match(run('find_files', { pattern: '.github/**', include_hidden: true }), /ci\.yml/);
      assert.match(
        run('find_files', { pattern: '.github/**', path: 'logs', include_hidden: true }),
        /sub\.yml/
      );
      // rg's explicit positive glob can override ignore rules for matching files.
      assert.match(run('find_files', { pattern: '*.log', path: 'logs' }), /quoted/);
      assert.match(
        run('find_files', { pattern: '*.log', path: 'logs', include_ignored: true }),
        /quoted/
      );
      const expanded = run('find_files', {
        pattern: '**/*',
        path: 'logs',
        include_hidden: true,
        include_ignored: true,
      });
      assert.ok(expanded.includes('unicode.txt'));
      assert.ok(!/node_modules[\\/]|\.git[\\/]|\.env|\.(?:pem|key)/i.test(expanded));
      assert.match(
        run('search_text', { pattern: 'third', path: "logs/probe 'quoted'.log" }),
        /3:third/
      );
      assert.equal(run('search_text', { pattern: 'third', path: 'logs' }), '');
      assert.match(
        run('search_text', { pattern: 'third', path: 'logs', include_ignored: true }),
        /3:third/
      );
      assert.equal(
        run('search_text', {
          pattern: 'fixture-check',
          path: 'logs',
          include_hidden: true,
          include_ignored: true,
        }),
        ''
      );
      assert.equal(run('search_text', { pattern: 'does-not-exist' }), '');
      const read = (args) =>
        JSON.parse(
          run('read_file', {
            file_path: "logs/probe 'quoted'.log",
            include_metadata: true,
            ...args,
          })
        );
      assert.deepEqual(read({ offset: 2, limit: 1 }), {
        mode: 'range',
        start_line: 2,
        returned_lines: 1,
        has_more_before: true,
        has_more_after: true,
        lines: ['second'],
      });
      assert.deepEqual(read({ tail: 2 }), {
        mode: 'tail',
        start_line: null,
        returned_lines: 2,
        has_more_before: true,
        has_more_after: false,
        lines: ['second', 'third'],
      });
      const whole = read({ tail: 2000 });
      assert.equal(whole.has_more_before, false);
      assert.equal(whole.returned_lines, 3);
      assert.equal(read({ offset: 100000, limit: 2000 }).returned_lines, 0);
      for (const options of [{ tail: 1 }, { offset: 2, limit: 1 }]) {
        const empty = read({ file_path: 'logs/empty.txt', ...options });
        assert.deepEqual(empty.lines, []);
        assert.equal(empty.has_more_before, false);
        assert.equal(empty.has_more_after, false);
      }
      const unicode = read({ file_path: 'logs/unicode.txt', tail: 2 });
      assert.deepEqual(unicode.lines, ['"quoted"', '$() ; escape']);
      assert.equal(run('read_file', { file_path: "logs/probe 'quoted'.log", tail: 1 }), 'third');
      run('read_file', { file_path: 'logs/missing.txt', tail: 1, include_metadata: true }, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
