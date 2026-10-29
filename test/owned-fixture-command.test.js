'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const vm = require('node:vm');
const { runOwnedFixtureCommand, cleanupHookFixture } = require('./helpers/owned-fixture-command');
const { createPipeHoldingFixture } = require('./helpers/pipe-holding-fixture');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('hook failure diagnostics report fixed stages and preserve primary identity without running tools', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'lint-staged-security.test.js'), 'utf8');
  const stages = ['setup', 'good_run', 'good_assert', 'bad_run', 'bad_assert'];
  for (const failureStage of [...stages, null]) {
    const primary = new Error('PRIVATE_HOOK_FAILURE_SENTINEL');
    const diagnostics = [];
    let callback;
    let hookCalls = 0;
    let staged = '';
    let cleaned = false;
    const dependencies = {
      'node:assert/strict': assert,
      'node:fs': {
        mkdtempSync: () => '/synthetic-fixture',
        writeFileSync(file, content) {
          if (file.endsWith('fixture.js')) staged = content;
        },
        readFileSync: () => 'module.exports = { value: 2 };\n',
      },
      'node:os': { tmpdir: () => '/synthetic-temp' },
      'node:path': path,
      'node:child_process': {
        spawnSync(executable, args) {
          if (failureStage === 'setup') throw primary;
          return { status: 0, stdout: args[0] === 'show' ? staged : '' };
        },
      },
      'node:test': (name, run) => {
        if (name.startsWith('upgraded lint-staged')) callback = run;
      },
      './helpers/hook-fixture-path': {
        createHookFixtureTools: () => ({ env: {}, gitExecutable: '/synthetic-git' }),
      },
      './helpers/owned-fixture-command': {
        async runOwnedFixtureCommand(executable, args, options) {
          assert.equal(options.timeoutMs, 30000);
          hookCalls++;
          const phase = hookCalls === 1 ? 'good' : 'bad';
          if (failureStage === phase + '_run') throw primary;
          if (phase === 'good') staged = 'module.exports = { value: 2 };\n';
          return {
            get failure() {
              if (failureStage === phase + '_assert') throw primary;
              return null;
            },
            status: phase === 'good' ? 0 : 1,
            stdout: phase === 'good' ? '' : 'no-undef',
            stderr: '',
          };
        },
        cleanupHookFixture(directory, error, safe) {
          cleaned = true;
          assert.equal(error, failureStage ? primary : undefined);
          assert.equal(safe, !failureStage?.endsWith('_run'));
          if (error) throw error;
        },
      },
      '../package.json': { 'lint-staged': { '*.js': ['eslint --fix', 'prettier --write'] } },
    };
    vm.runInNewContext(source, {
      __dirname,
      process: { execPath: '/synthetic-node', platform: process.platform, env: {} },
      require(name) {
        assert.ok(Object.hasOwn(dependencies, name));
        return dependencies[name];
      },
    });
    assert.equal(typeof callback, 'function');
    const pending = callback({ diagnostic: (value) => diagnostics.push(value) });
    if (failureStage) await assert.rejects(pending, (error) => error === primary);
    else await pending;
    assert.equal(cleaned, true);
    assert.deepEqual(diagnostics, failureStage ? ['hook_failure_stage=' + failureStage] : []);
    assert.equal(
      hookCalls,
      failureStage === 'setup' ? 0 : failureStage?.startsWith('good') ? 1 : 2
    );
  }
});

function fixture() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 12345;
  let expire,
    stopped = 0,
    release;
  const pending = runOwnedFixtureCommand(
    process.execPath,
    [],
    {
      cwd: __dirname,
      env: {},
      timeoutMs: 30000,
    },
    {
      spawnChild(executable, args, options) {
        assert.equal(executable, process.execPath);
        assert.deepEqual(args, []);
        assert.equal(options.shell, false);
        assert.equal(options.windowsHide, true);
        assert.equal(options.detached, process.platform !== 'win32');
        return child;
      },
      setTimer(callback, delay) {
        assert.equal(delay, 30000);
        expire = callback;
        return 1;
      },
      clearTimer(id) {
        assert.equal(id, 1);
      },
      terminate(value) {
        assert.equal(value, child);
        stopped++;
        return new Promise((resolve, reject) => {
          release = { resolve, reject };
        });
      },
    }
  );
  return { child, pending, expire: () => expire(), stopped: () => stopped, release: () => release };
}

test('owned fixture commands preserve success, empty output and nonzero tool failures', async () => {
  for (const code of [0, 1]) {
    const f = fixture();
    if (code) f.child.stderr.emit('data', Buffer.from('no-undef'));
    f.child.emit('close', code, null);
    assert.deepEqual(await f.pending, {
      status: code,
      signal: null,
      failure: null,
      stdout: '',
      stderr: code ? 'no-undef' : '',
    });
    assert.equal(f.stopped(), 0);
  }
});

test('deadline remains 30 seconds and cannot finish before the descendant terminator completes', async () => {
  const f = fixture();
  let finished = false;
  f.pending.then(() => {
    finished = true;
  });
  f.expire();
  f.expire();
  await tick();
  assert.equal(f.stopped(), 1);
  f.child.emit('close', null, 'SIGTERM');
  await tick();
  assert.equal(finished, false);
  f.release().resolve();
  assert.equal((await f.pending).failure, 'timeout');
});

test('termination first still awaits pipe close; excessive output stops the whole owned tree', async () => {
  const f = fixture();
  f.child.stdout.emit('data', Buffer.alloc(1024 * 1024 + 1));
  await tick();
  f.release().resolve();
  await tick();
  f.child.emit('close', null, 'SIGKILL');
  const result = await f.pending;
  assert.equal(result.failure, 'output_limit');
  assert.equal(result.stdout, '');
  assert.equal(f.stopped(), 1);
});

test('launch and termination errors remain safe failures, never successful cleanup permission', async () => {
  const f = fixture();
  f.child.emit('error', new Error('PRIVATE_LAUNCH_DETAILS'));
  f.child.emit('close', null, null);
  assert.equal((await f.pending).failure, 'launch_failed');
  const g = fixture();
  const rejected = assert.rejects(g.pending, { message: 'Owned fixture termination failed' });
  g.expire();
  await tick();
  g.release().reject(new Error('PRIVATE_TERMINATOR_DETAILS'));
  g.child.emit('close', null, 'SIGKILL');
  await rejected;
});

test('safe termination failures retain deadline and bounded taskkill classifications', async () => {
  for (const [raw, expected] of [
    [
      Object.assign(new Error('PRIVATE_KILLED'), { killed: true, code: null }),
      { kind: 'killed', code: null },
    ],
    [
      Object.assign(new Error('PRIVATE_TIMEOUT'), { code: 'ETIMEDOUT' }),
      { kind: 'timeout', code: 'ETIMEDOUT' },
    ],
    [Object.assign(new Error('PRIVATE_EXIT'), { code: 128 }), { kind: 'exit_failure', code: 128 }],
    [
      Object.assign(new Error('PRIVATE_ACCESS'), { code: 'EACCES' }),
      { kind: 'system_error', code: 'EACCES' },
    ],
    [
      Object.assign(new Error('PRIVATE_MISSING_PID'), { code: 'ESRCH' }),
      { kind: 'system_error', code: 'ESRCH' },
    ],
    [
      Object.assign(new Error('PRIVATE_INVALID_PID'), { code: 'ERR_INVALID_OWNED_PID' }),
      { kind: 'invalid_pid', code: 'ERR_INVALID_OWNED_PID' },
    ],
    [
      Object.assign(new Error('PRIVATE_BUFFER'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        killed: true,
      }),
      { kind: 'output_limit', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
    ],
    [
      Object.assign(new Error('PRIVATE_EDGE'), { code: -2147483648 }),
      { kind: 'exit_failure', code: -2147483648 },
    ],
    [
      Object.assign(new Error('PRIVATE_EDGE'), { code: 4294967295 }),
      { kind: 'exit_failure', code: 4294967295 },
    ],
    [null, { kind: 'unknown', code: null }],
    [Object.assign(new Error('PRIVATE_EMPTY'), { code: '' }), { kind: 'unknown', code: null }],
    [
      Object.assign(new Error('PRIVATE_EXTREME'), { code: -2147483649 }),
      { kind: 'unknown', code: null },
    ],
    [
      Object.assign(new Error('PRIVATE_CODE'), { code: 'TOKEN=PRIVATE_SECRET' }),
      { kind: 'unknown', code: null },
    ],
    [
      Object.assign(new Error('PRIVATE_EXTREME'), { code: Infinity }),
      { kind: 'unknown', code: null },
    ],
    [
      Object.assign(new Error('PRIVATE_EXTREME'), { code: 4294967296 }),
      { kind: 'unknown', code: null },
    ],
  ]) {
    const f = fixture();
    const rejected = assert.rejects(f.pending, (error) => {
      assert.equal(error.message, 'Owned fixture termination failed');
      assert.equal(error.failure, 'timeout');
      assert.deepEqual(error.termination, expected);
      assert.deepEqual(Object.keys(error).sort(), ['failure', 'termination']);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      assert.ok(!JSON.stringify(error).includes('PRIVATE'));
      return true;
    });
    f.expire();
    await tick();
    f.release().reject(raw);
    await rejected;
    f.child.emit('close', null, 'SIGKILL');
  }
});

test('safe termination classification never evaluates accessors or keeps unknown error content', async () => {
  let reads = 0;
  let trapCalls = 0;
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const accessor = Object.defineProperties(
    {},
    {
      code: {
        get() {
          reads++;
          throw new Error('PRIVATE_ACCESSOR');
        },
      },
      killed: {
        get() {
          reads++;
          throw new Error('PRIVATE_ACCESSOR');
        },
      },
    }
  );
  for (const raw of [
    accessor,
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          trapCalls++;
          throw new Error('PRIVATE_PROXY');
        },
      }
    ),
    new Proxy(Object.assign(new Error('PRIVATE_PROXY'), { code: 'ETIMEDOUT' }), {
      getOwnPropertyDescriptor() {
        trapCalls++;
        return { value: 'ETIMEDOUT', configurable: true };
      },
    }),
    revoked.proxy,
  ]) {
    const f = fixture();
    const rejected = assert.rejects(f.pending, (error) => {
      assert.equal(error.failure, 'timeout');
      assert.deepEqual(error.termination, { kind: 'unknown', code: null });
      assert.ok(!JSON.stringify(error).includes('PRIVATE'));
      return true;
    });
    f.expire();
    await tick();
    f.release().reject(raw);
    await rejected;
  }
  assert.equal(reads, 0);
  assert.equal(trapCalls, 0);
});

test('safe termination rejection stays failed when root exits before descendant pipe close', async () => {
  const f = fixture();
  const rejected = assert.rejects(f.pending, (error) => {
    assert.equal(error.failure, 'timeout');
    assert.deepEqual(error.termination, { kind: 'exit_failure', code: 128 });
    return true;
  });
  f.child.emit('exit', 0, null);
  f.expire();
  await tick();
  f.release().reject(Object.assign(new Error('PRIVATE_PID_NOT_FOUND'), { code: 128 }));
  await rejected;
  f.child.emit('close', 0, null);
  assert.equal(f.stopped(), 1);
});

test('safe termination rejection retains output limit independently from terminator failure', async () => {
  const f = fixture();
  const rejected = assert.rejects(f.pending, (error) => {
    assert.equal(error.failure, 'output_limit');
    assert.deepEqual(error.termination, { kind: 'system_error', code: 'EPERM' });
    assert.ok(!JSON.stringify(error).includes('PRIVATE'));
    return true;
  });
  f.child.stdout.emit('data', Buffer.alloc(1024 * 1024 + 1));
  await tick();
  f.release().reject(
    Object.assign(new Error('PRIVATE_OUTPUT'), {
      code: 'EPERM',
      stdout: 'PRIVATE_OUTPUT',
      env: 'PRIVATE_ENV',
    })
  );
  await rejected;
});

test('safe launch failure excludes raw launch error details', async () => {
  await assert.rejects(
    runOwnedFixtureCommand(
      process.execPath,
      [],
      { cwd: __dirname, env: {}, timeoutMs: 30000 },
      {
        spawnChild() {
          throw new Error('PRIVATE_LAUNCH');
        },
      }
    ),
    (error) => {
      assert.equal(error.message, 'Owned fixture launch failed');
      assert.equal(error.failure, 'launch_failed');
      assert.equal(error.termination, null);
      assert.ok(!JSON.stringify(error).includes('PRIVATE'));
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    }
  );
});

test('safe cleanup diagnostic uses only private fixed fields, never mutable public properties', async () => {
  const f = fixture();
  const caught = f.pending.catch((error) => error);
  f.expire();
  await tick();
  f.release().reject(Object.assign(new Error('PRIVATE_RAW'), { code: 128 }));
  const primary = await caught;
  let reads = 0;
  Object.defineProperties(primary, {
    failure: {
      get() {
        reads++;
        throw new Error('PRIVATE_FIELD');
      },
    },
    termination: {
      get() {
        reads++;
        throw new Error('PRIVATE_FIELD');
      },
    },
  });
  const directory = path.join(os.tmpdir(), 'hpm-lint-staged-fixture-synthetic');
  const neverRemove = () => assert.fail('live fixture must be retained');
  assert.throws(
    () => cleanupHookFixture(directory, primary, false, neverRemove),
    (error) => {
      assert.match(error.message, /diagnostic primary=timeout termination=exit_failure code=128$/);
      assert.ok(!error.message.includes('PRIVATE'));
      assert.equal(error.errors[0], primary);
      return true;
    }
  );
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        reads++;
        throw new Error('PRIVATE_PROXY');
      },
      get() {
        reads++;
        throw new Error('PRIVATE_PROXY');
      },
    }
  );
  assert.throws(
    () => cleanupHookFixture(directory, hostile, false, neverRemove),
    (error) => {
      assert.match(error.message, /diagnostic primary=unknown termination=unknown code=none$/);
      return true;
    }
  );
  assert.equal(reads, 0);
});

test('TAP failure output includes safe cleanup classification without raw error content', () => {
  const helper = path.join(__dirname, 'helpers/owned-fixture-command.js');
  const directory = path.join(os.tmpdir(), 'hpm-lint-staged-fixture-synthetic');
  const source = `
    const {test}=require('node:test');
    const {EventEmitter}=require('node:events');
    const {runOwnedFixtureCommand,cleanupHookFixture}=require(${JSON.stringify(helper)});
    test('synthetic retained fixture diagnostic',async()=>{
      const child=new EventEmitter(); child.stdout=new EventEmitter(); child.stderr=new EventEmitter(); child.pid=12345;
      let expire;
      const pending=runOwnedFixtureCommand(process.execPath,[],{cwd:${JSON.stringify(__dirname)},env:{},timeoutMs:30000},{spawnChild:()=>child,setTimer:callback=>{expire=callback;return 1;},clearTimer(){},terminate:()=>Promise.reject(Object.assign(new Error('PRIVATE_RAW_ERROR'),{code:'ETIMEDOUT',stdout:'PRIVATE_STDOUT',args:['PRIVATE_ARGS'],env:'PRIVATE_ENV'}))});
      const caught=pending.catch(error=>error); expire();
      cleanupHookFixture(${JSON.stringify(directory)},await caught,false,()=>{throw new Error('unexpected removal');});
    });
  `;
  // This independent reporter probe must not inherit the parent's binary
  // runner transport. It still executes and reports its deliberately failed test.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['-e', source], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /TAP version 13/);
  assert.match(result.stdout, /diagnostic primary=timeout termination=timeout code=ETIMEDOUT/);
  assert.ok(!(result.stdout + result.stderr).includes('PRIVATE_'));
});

test('removal diagnostic preserves signed primary details and both original failures', async () => {
  const f = fixture();
  const caught = f.pending.catch((error) => error);
  f.expire();
  await tick();
  f.release().reject(Object.assign(new Error('PRIVATE_TERMINATION'), { code: 'ETIMEDOUT' }));
  const primary = await caught;
  let reads = 0;
  Object.defineProperty(primary, 'failure', {
    get() {
      reads++;
      throw new Error('PRIVATE_PRIMARY');
    },
  });
  const cleanup = Object.assign(new Error('PRIVATE_CLEANUP'), { code: 'EBUSY' });
  const directory = path.join(os.tmpdir(), 'hpm-lint-staged-fixture-synthetic');
  assert.throws(
    () =>
      cleanupHookFixture(directory, primary, true, () => {
        throw cleanup;
      }),
    (error) => {
      assert.equal(
        error.message,
        'Hook fixture cleanup failed; primary failure preserved; diagnostic primaryPresent=true primary=timeout cleanupCode=EBUSY'
      );
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], primary);
      assert.equal(error.errors[1], cleanup);
      assert.equal(error.cause, cleanup);
      assert.doesNotMatch(error.message, /PRIVATE|hpm-lint-staged/);
      return true;
    }
  );
  assert.equal(reads, 0);
});

test('removal diagnostic only accepts own whitelisted cleanup codes and never reads hostile inputs', () => {
  const directory = path.join(os.tmpdir(), 'hpm-lint-staged-fixture-synthetic');
  let reads = 0;
  const accessor = Object.defineProperty({}, 'code', {
    get() {
      reads++;
      throw new Error('PRIVATE_ACCESSOR');
    },
  });
  const inherited = Object.create({ code: 'EBUSY' });
  const hostile = new Proxy(
    {},
    {
      get() {
        reads++;
        throw new Error('PRIVATE_PROXY');
      },
      getOwnPropertyDescriptor() {
        reads++;
        throw new Error('PRIVATE_PROXY');
      },
      getPrototypeOf() {
        reads++;
        throw new Error('PRIVATE_PROXY');
      },
    }
  );
  for (const [cleanup, expected] of [
    [{ code: 'EBUSY' }, 'EBUSY'],
    [{ code: 'EPERM' }, 'EPERM'],
    [{ code: 'EACCES' }, 'EACCES'],
    [{ code: 'ENOTEMPTY' }, 'ENOTEMPTY'],
    [{ code: 'PRIVATE_CODE' }, 'unknown'],
    [{ code: 128 }, 'unknown'],
    [{ code: {} }, 'unknown'],
    [null, 'unknown'],
    ['PRIVATE_THROWN_STRING', 'unknown'],
    [accessor, 'unknown'],
    [inherited, 'unknown'],
    [hostile, 'unknown'],
  ]) {
    for (const primary of [undefined, new Error('PRIVATE_PRIMARY'), hostile]) {
      assert.throws(
        () =>
          cleanupHookFixture(directory, primary, true, () => {
            throw cleanup;
          }),
        (error) => {
          assert.match(
            error.message,
            new RegExp(
              'diagnostic primaryPresent=' +
                Boolean(primary) +
                ' primary=' +
                (primary ? 'unknown' : 'none') +
                ' cleanupCode=' +
                expected +
                '$'
            )
          );
          assert.equal(error.cause, cleanup);
          assert.equal(error.errors.length, primary ? 2 : 1);
          if (primary) assert.equal(error.errors[0], primary);
          return true;
        }
      );
    }
  }
  assert.equal(reads, 0);
});

test('removal TAP failures expose only safe diagnostic fields and keep getters and Proxy traps idle', () => {
  const helper = path.join(__dirname, 'helpers/owned-fixture-command.js');
  const directory = path.join(os.tmpdir(), 'hpm-lint-staged-fixture-synthetic');
  const source = `
    const {test}=require('node:test');
    const {EventEmitter}=require('node:events');
    const {runOwnedFixtureCommand,cleanupHookFixture}=require(${JSON.stringify(helper)});
    let reads=0;
    process.once('exit',()=>{process.stdout.write('# diagnosticAccesses '+reads+'\\n');if(reads)process.exitCode=9;});
    const directory=${JSON.stringify(directory)};
    test('synthetic removal without primary',()=>cleanupHookFixture(directory,undefined,true,()=>{throw Object.assign(new Error('PRIVATE_CLEANUP'),{code:'EPERM'});}));
    test('synthetic removal with signed primary',async()=>{
      const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.pid=12345;
      let expire;
      const pending=runOwnedFixtureCommand(process.execPath,[],{cwd:${JSON.stringify(__dirname)},env:{},timeoutMs:30000},{spawnChild:()=>child,setTimer:callback=>{expire=callback;return 1;},clearTimer(){},terminate:()=>Promise.reject(new Error('PRIVATE_TERMINATOR'))});
      const caught=pending.catch(error=>error);expire();const primary=await caught;
      Object.defineProperty(primary,'failure',{get(){reads++;throw new Error('PRIVATE_GETTER');}});
      cleanupHookFixture(directory,primary,true,()=>{throw Object.assign(new Error('PRIVATE_CLEANUP'),{code:'EBUSY'});});
    });
    test('synthetic removal with hostile cleanup',()=>{
      const cleanup=new Proxy({},{get(){reads++;throw new Error('PRIVATE_PROXY');},getOwnPropertyDescriptor(){reads++;throw new Error('PRIVATE_PROXY');},getPrototypeOf(){reads++;throw new Error('PRIVATE_PROXY');}});
      cleanupHookFixture(directory,new Error('PRIVATE_PRIMARY'),true,()=>{throw cleanup;});
    });
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['-e', source], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /# tests 3/);
  assert.match(result.stdout, /# fail 3/);
  for (const diagnostic of [
    'primaryPresent=false primary=none cleanupCode=EPERM',
    'primaryPresent=true primary=timeout cleanupCode=EBUSY',
    'primaryPresent=true primary=unknown cleanupCode=unknown',
  ])
    assert.ok(result.stdout.includes(diagnostic));
  assert.match(result.stdout, /# diagnosticAccesses 0/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_|hpm-lint-staged-fixture-synthetic/);
});

test('invalid, unsafe and extreme command inputs are rejected before launching', () => {
  const base = { cwd: __dirname, env: {}, timeoutMs: 30000 };
  for (const [exe, args, options] of [
    ['relative', [], base],
    [process.execPath + '\0', [], base],
    [process.execPath, null, base],
    [process.execPath, ['\0'], base],
    [process.execPath, [], { ...base, cwd: '' }],
    [process.execPath, [], { ...base, env: null }],
    [process.execPath, [], { ...base, timeoutMs: 0 }],
    [process.execPath, [], { ...base, timeoutMs: 30001 }],
    [process.execPath, [], { ...base, timeoutMs: Infinity }],
  ])
    assert.throws(() => runOwnedFixtureCommand(exe, args, options), TypeError);
});

test('real timeout terminates a launcher and its pipe-owning descendant', async (t) => {
  const owned = createPipeHoldingFixture();
  t.after(() => owned.close());
  const result = await runOwnedFixtureCommand(
    process.execPath,
    owned.args,
    { cwd: __dirname, env: process.env, timeoutMs: 5000 },
    { spawnChild: owned.spawnChild }
  );
  assert.equal(result.failure, 'timeout');
  assert.notEqual(result.status, 73, 'fixture fallback must not satisfy tree termination');
  const { descendant } = JSON.parse(result.stdout);
  assert.ok(Number.isSafeInteger(descendant) && descendant > 0);
  // Pipe close proves descendant termination on both platforms; Windows also
  // permits a PID check without POSIX's transient unreaped-zombie ambiguity.
  if (process.platform === 'win32') assert.throws(() => process.kill(descendant, 0));
});

test('a failed tree terminator stays rejected while the disposable fixture closes its pipes', async (t) => {
  const owned = createPipeHoldingFixture();
  t.after(() => owned.close());
  let launcher, descendant, expired, ready;
  const launched = new Promise((resolve) => {
    ready = resolve;
  });
  const pending = runOwnedFixtureCommand(
    process.execPath,
    owned.args,
    { cwd: __dirname, env: process.env, timeoutMs: 5000 },
    {
      spawnChild(...args) {
        launcher = owned.spawnChild(...args);
        launcher.stdout.once('data', (bytes) => {
          descendant = JSON.parse(bytes.toString('utf8')).descendant;
          ready();
        });
        return launcher;
      },
      setTimer(callback) {
        expired = callback;
        return 1;
      },
      clearTimer() {},
      terminate() {
        return Promise.reject(new Error('PRIVATE_TERMINATOR_FAILURE'));
      },
    }
  );
  // Attach before starting the simulated deadline to avoid an unhandled
  // rejection. Cleanup is tested separately from the rejected operation.
  const rejected = assert.rejects(pending, { message: 'Owned fixture termination failed' });
  await launched;
  assert.ok(Number.isSafeInteger(descendant) && descendant > 0);
  assert.throws(() => owned.spawnChild(process.execPath, owned.args, {}), TypeError);
  expired();
  await rejected;
  assert.equal(launcher.exitCode, null);
  await owned.close();
  await owned.close();
  assert.equal(launcher.exitCode, 73);
  if (process.platform === 'win32') assert.throws(() => process.kill(descendant, 0));
});

test('disposable pipe fixtures reject unrelated commands and cannot launch after empty cleanup', async () => {
  for (const launch of [null, false, 1, '', {}])
    assert.throws(() => createPipeHoldingFixture(launch), {
      name: 'TypeError',
      message: 'Invalid disposable fixture launcher',
    });
  const owned = createPipeHoldingFixture();
  for (const [executable, args] of [
    ['relative', owned.args],
    [process.execPath, null],
    [process.execPath, []],
    [process.execPath, ['-e', 'unrelated code']],
    [process.execPath, [...owned.args, 'extra']],
    [process.execPath + '\0', owned.args],
  ]) {
    assert.throws(() => owned.spawnChild(executable, args, {}), {
      name: 'TypeError',
      message: 'Invalid disposable fixture launch',
    });
  }
  await owned.close();
  await owned.close();
  assert.throws(() => owned.spawnChild(process.execPath, owned.args, {}), {
    name: 'TypeError',
    message: 'Invalid disposable fixture launch',
  });
});

test('disposable pipe cleanup reports IPC failure safely instead of claiming completion', async () => {
  const child = new EventEmitter();
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    connected: true,
    send(_message, callback) {
      callback(new Error('PRIVATE_IPC_DETAILS'));
    },
  });
  const owned = createPipeHoldingFixture(() => child);
  owned.spawnChild(process.execPath, owned.args, {});
  await assert.rejects(owned.close(), { message: 'Disposable fixture cleanup signal failed' });
  child.emit('close');
});

test('cleanup retains primary failure, reports EBUSY separately and never removes a live or unsafe fixture', () => {
  const directory = path.join(os.tmpdir(), 'hpm-lint-staged-fixture-synthetic');
  const primary = new Error('original hook deadline');
  const busy = new Error('synthetic EBUSY');
  assert.throws(
    () =>
      cleanupHookFixture(directory, primary, true, () => {
        throw busy;
      }),
    (error) =>
      error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === busy
  );
  assert.throws(
    () => cleanupHookFixture(directory, primary, true, () => {}),
    (error) => error === primary
  );
  assert.throws(
    () =>
      cleanupHookFixture(directory, null, true, () => {
        throw busy;
      }),
    (error) =>
      error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === busy
  );
  const neverRemove = () => {
    assert.fail('unsafe fixture must not be removed');
  };
  assert.throws(
    () => cleanupHookFixture(directory, primary, false, neverRemove),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === primary &&
      /retained/.test(error.message)
  );
  for (const value of [null, '', os.tmpdir(), __dirname, path.join(os.tmpdir(), 'other-fixture')])
    assert.throws(() => cleanupHookFixture(value, null, true, neverRemove), TypeError);
  cleanupHookFixture(directory, null, true, (value, options) => {
    assert.equal(value, directory);
    assert.deepEqual(options, { recursive: true, force: true });
  });
});
