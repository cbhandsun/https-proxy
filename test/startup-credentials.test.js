'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { setImmediate: flush } = require('node:timers/promises');
const { createStartupCredentials } = require('../lib/proxy/startup-credentials');

test('core target detection defers protocol-specific validators but the first matching request still validates', () => {
  const script = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const blocked = new Set(['responses-request-options', 'claude-modern-options', 'converted-output-format', 'deepseek-responses-contract', 'deepseek-search-history', 'deepseek-claude-reasoning', 'converted-chat-request', 'context-budget-manager', 'context-optimizer', 'context-cache-planner', 'route-response-helpers']);
    const original = Module._load;
    try {
      Module._load = function(name, ...args) {
        if (blocked.has(name.split('/').at(-1))) throw new Error('eager_protocol_validator');
        return original.call(this, name, ...args);
      };
      require('./lib/proxy/core-request-handler');
    } finally { Module._load = original; }
    const deepseek = require('./lib/proxy/deepseek-request-contract');
    const workbuddy = require('./lib/proxy/workbuddy-request-contract');
    deepseek.preflightDeepSeekRequest({profile:{protocol:'openai',targetUrl:'https://example.invalid'},model:'deepseek-v4-flash'});
    workbuddy.preflightWorkBuddyRequest({profile:{protocol:'openai'},model:'deepseek-v4-flash'});
    const body = {response_format:{type:'json_schema',json_schema:{name:'synthetic',schema:{type:'object'}}}};
    assert.throws(()=>deepseek.validateDeepSeekOutputFormat(body,'chat','deepseek-v4-flash','openai'),{code:'invalid_request_error'});
    assert.throws(()=>workbuddy.validateWorkBuddyRequest(body,'chat','deepseek-v4-flash'),{code:'invalid_request_error'});
    const prepared = {profile:{protocol:'openai',targetUrl:'https://api.deepseek.com/v1'},model:'deepseek-v4-flash',buffer:Buffer.from(JSON.stringify({model:'deepseek-v4-flash',messages:[{role:'user',content:'synthetic'}]}))};
    deepseek.preflightDeepSeekRequest(prepared,{requestPath:'/v1/chat/completions'});
    workbuddy.validateWorkBuddyRequest({messages:[]},'chat','deepseek-v4-flash');
    const planned = require('./lib/proxy/workbuddy-official').sanitizeWorkBuddyChatBody({model:'deepseek-v4-flash',messages:[{role:'developer',content:'synthetic'}]});
    assert.equal(planned.messages[0].role,'system');
    assert.equal(planned.messages[0].content,'synthetic');
    const overflow = require('./lib/proxy/context-overflow-response');
    assert.equal(require('./lib/proxy/context-budget-manager').rejectContextOverflow,overflow.rejectContextOverflow);
    for(const body of [null,{}, {__hpmDiagnostics:{contextBudget:{enabled:false,overBudgetTokens:1}}}, {__hpmDiagnostics:{contextBudget:{enabled:true,overBudgetTokens:0}}}])
      assert.equal(overflow.rejectContextOverflow({},body,()=>assert.fail('unexpected overflow')),false);
    let rejection;
    assert.equal(overflow.rejectContextOverflow({}, {__hpmDiagnostics:{contextBudget:{enabled:true,overBudgetTokens:1}}},(_response,status,body)=>{rejection={status,body};}),true);
    assert.equal(rejection.status,400);
    assert.equal(rejection.body.error.code,'context_length_exceeded');
    const {isCodexResponsesTarget: target} = require('./lib/proxy/responses-target');
    assert.equal(require('./lib/proxy/responses-request-options').isCodexResponsesTarget,target);
    for(const [profile, endpoint, expected] of [[null,null,false],[{}, {},false],[{api:'openai-codex-responses'},null,true],[{}, {path:'/backend-api'},true],[{}, {path:'/backend-api/codex'},true],[{}, {path:'/backend-api-evil'},false],[{}, {path:3},false]])
      assert.equal(target(profile,endpoint),expected);
    const {tryHandleContextRecoveryConvertedHttp} = require('./lib/proxy/context-recovery-converted-http');
    const unavailable = new Error('synthetic_module_unavailable');
    try {
      Module._load = function(name,...args) {
        if(name==='./handlers/converted-chat-request') throw unavailable;
        return original.call(this,name,...args);
      };
      assert.throws(()=>tryHandleContextRecoveryConvertedHttp({label:'responses->chat',prepared:{profile:{},buffer:Buffer.from('{}')},target:{},converters:{}}),error=>error===unavailable);
    } finally { Module._load=original; }
    try {
      Module._load = function(name,...args) {
        if(name==='./converted-output-format') throw unavailable;
        return original.call(this,name,...args);
      };
      for(const validate of [()=>deepseek.validateDeepSeekOutputFormat({},'chat','deepseek-v4-flash','openai'),()=>workbuddy.validateWorkBuddyRequest({},'chat','deepseek-v4-flash')])
        assert.throws(validate,error=>error===unavailable);
    } finally { Module._load=original; }
    process.stdout.write('deferred_provider_validation_ok');
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, 'deferred provider validation must complete successfully');
  assert.equal(result.stdout, 'deferred_provider_validation_ok');
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

test('credential gate waits for persistence, starts once and drains before releasing ownership', async () => {
  for (const stopping of [false, true]) {
    const write = deferred();
    const calls = [];
    const gate = createStartupCredentials({
      write() {
        calls.push('write');
        return write.promise;
      },
      onReady() {
        calls.push('ready');
      },
      onFailure() {
        calls.push('failed');
      },
    });
    assert.equal(gate.ready(), false);
    const pending = gate.start();
    assert.equal(gate.start(), pending);
    await flush();
    assert.deepEqual(calls, ['write']);
    assert.equal(gate.ready(), false);
    if (stopping) assert.equal(gate.stop(), pending);
    write.resolve('synthetic-token');
    assert.equal(await pending, true);
    assert.equal(gate.ready(), !stopping);
    assert.deepEqual(calls, stopping ? ['write'] : ['write', 'ready']);
    assert.equal(await gate.stop(), true);
    assert.equal(gate.ready(), false);
    assert.equal(gate.start(), pending);
  }
});

test('credential gate rejects failures and unsafe promise shapes without invoking getters', async () => {
  for (const mode of [
    'throw',
    'reject',
    'thenable',
    'getter',
    'object',
    'ready-failure',
    'observer-failure',
  ]) {
    let getters = 0,
      failures = 0,
      ready = 0;
    const gate = createStartupCredentials({
      write() {
        if (mode === 'throw' || mode === 'observer-failure')
          throw new Error('PRIVATE_NATIVE_ERROR');
        if (mode === 'reject') return Promise.reject(new Error('PRIVATE_NATIVE_ERROR'));
        if (mode === 'thenable' || mode === 'getter')
          return {
            get then() {
              getters++;
              throw new Error('PRIVATE_NATIVE_ERROR');
            },
          };
        if (mode === 'object') return {};
        return undefined;
      },
      onReady() {
        ready++;
        throw new Error('PRIVATE_NATIVE_ERROR');
      },
      onFailure(...args) {
        assert.deepEqual(args, []);
        failures++;
        if (mode === 'observer-failure') throw new Error('PRIVATE_NATIVE_ERROR');
      },
    });
    assert.equal(await gate.start(), false);
    assert.equal(gate.ready(), false);
    assert.equal(await gate.stop(), false);
    assert.equal(failures, 1);
    assert.equal(getters, 0);
    assert.equal(ready, mode === 'ready-failure' ? 1 : 0);
  }
  const stopped = createStartupCredentials({
    write() {
      assert.fail('late write');
    },
    onReady() {},
    onFailure() {},
  });
  assert.equal(await stopped.stop(), true);
  assert.equal(await stopped.start(), false);
  for (const name of ['write', 'onReady', 'onFailure'])
    assert.throws(() =>
      createStartupCredentials({ write() {}, onReady() {}, onFailure() {}, [name]: null })
    );
});
