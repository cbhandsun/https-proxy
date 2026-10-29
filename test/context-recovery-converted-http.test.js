'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createIsolatedTestEnv } = require('../lib/test-runtime');
const {
  tryHandleContextRecoveryConvertedHttp,
} = require('../lib/proxy/context-recovery-converted-http');
const { recoveryConverters } = require('./helpers/recovery-converters');
const {
  createContextRecoveryHttpDispatch,
} = require('../lib/proxy/context-recovery-http-dispatch');

test('all nine trusted conversion routes send exact long histories through real HTTP without enlarging replies', async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      requests.push({
        body: JSON.parse(bytes.toString('utf8')),
        bytes: bytes.length,
        length: request.headers['content-length'],
      });
      const text = 'finished';
      const payload =
        request.url === '/responses'
          ? {
              id: 'resp-local',
              status: 'completed',
              model: 'model',
              created_at: 1700000000,
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text, annotations: [] }],
                },
              ],
              usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
            }
          : request.url === '/claude'
            ? {
                id: 'msg-local',
                type: 'message',
                role: 'assistant',
                model: 'model',
                content: [{ type: 'text', text }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 2, output_tokens: 1 },
              }
            : request.url === '/gemini'
              ? {
                  candidates: [
                    { content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' },
                  ],
                  usageMetadata: {
                    promptTokenCount: 2,
                    candidatesTokenCount: 1,
                    totalTokenCount: 3,
                  },
                }
              : {
                  id: 'chat-local',
                  model: 'model',
                  choices: [
                    {
                      index: 0,
                      message: { role: 'assistant', content: text },
                      finish_reason: 'stop',
                    },
                  ],
                  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
                };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    } catch {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{}');
    }
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const history = Array.from({ length: 3 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: String(index) + '原文🙂'.repeat(90000),
  }));
  const families = [
    [
      'chat',
      ['responses', 'claude'],
      'context-recovery-conversion',
      'createContextRecoveryConversion',
    ],
    [
      'responses',
      ['chat', 'claude'],
      'context-recovery-responses-conversion',
      'createContextRecoveryResponsesConversion',
    ],
    [
      'claude',
      ['chat', 'responses'],
      'context-recovery-messages-conversion',
      'createContextRecoveryMessagesConversion',
    ],
    [
      'gemini',
      ['chat', 'responses', 'claude'],
      'context-recovery-gemini-conversion',
      'createContextRecoveryGeminiConversion',
    ],
  ];
  for (const [upstream, kinds, file, name] of families) {
    for (const kind of kinds) {
      const body = { model: 'model', [kind === 'responses' ? 'input' : 'messages']: history };
      const conversion = require('../lib/proxy/' + file)[name]({
        kind,
        model: 'vendor/model',
        converters: recoveryConverters(),
        historyFormat: 3,
      });
      const dispatch = createContextRecoveryHttpDispatch(
        http,
        {
          hostname: '127.0.0.1',
          port: server.address().port,
          path: '/' + upstream,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        () => true,
        { kind: upstream, historyFormat: 3 }
      );
      const signal = new globalThis.AbortController().signal;
      const result = await conversion.createDispatch(dispatch)(body, { signal });
      assert.equal(result.statusCode, 200);
      assert.ok(result.wire.length < 2 * 1024 * 1024);
      assert.match(result.wire.toString('utf8'), /finished/);
      const sent = requests.at(-1);
      assert.ok(sent.bytes > 2 * 1024 * 1024);
      assert.equal(sent.length, String(sent.bytes));
      const messages = sent.body.input ?? sent.body.messages ?? sent.body.contents;
      const texts = messages.map((item) =>
        typeof item.content === 'string'
          ? item.content
          : (item.content ?? item.parts).map((block) => block.text).join('')
      );
      assert.deepEqual(
        texts,
        history.map((item) => item.content),
        kind + '->' + upstream
      );
    }
  }
  assert.equal(requests.length, 9);
});

test('cold proxy and ordinary conversions leave optional WorkBuddy execution modules unloaded', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-lazy-workbuddy-'));
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const script = `
    const assert = require('node:assert/strict');
    const names = ['workbuddy-context-planner', 'workbuddy-wbipc-client',
      'workbuddy-host-recovery', 'context-recovery-wbipc-entry',
      'context-recovery-conversion', 'context-recovery-responses-conversion',
      'context-recovery-messages-conversion', 'context-recovery-gemini-conversion'];
    const files = names.map(name => require.resolve('./lib/proxy/' + name));
    const unloaded = () => files.forEach((file, index) =>
      assert.equal(Boolean(require.cache[file]), false, names[index]));
    require('./lib/proxy/core-request-handler');
    unloaded();
    const {tryHandleContextRecoveryConvertedHttp: convert} =
      require('./lib/proxy/context-recovery-converted-http');
    for (const prepared of [{profile:{}}, {profile:{},authMode:'official-login',authProvider:'openai'}]) {
      assert.equal(convert({label:'unsupported',prepared}), false);
      unloaded();
    }
    const {createWorkBuddyHttpTransport: create} = require('./lib/proxy/workbuddy-http-transport');
    for (const prepared of [undefined, null, {}, {profile:{protocol:'openai'}},
      {authProvider:'workbuddy'}, {profile:{protocol:'workbuddy'},workbuddyAuth:{}}]) {
      assert.equal(create(prepared, ''), null);
      unloaded();
    }
    const prepared = {authProvider:'workbuddy',workbuddyAuth:{accessTokenEncrypted:true}};
    assert.equal(create(prepared, 'synthetic-key'), null);
    unloaded();
    const client = {request(){throw Error('unexpected_request')}};
    const Module = require('node:module');
    const load = Module._load;
    const failure = new Error('synthetic_optional_import_failure');
    for (const [label, module] of [
      ['responses->chat', './context-recovery-conversion'],
      ['chat->responses', './context-recovery-responses-conversion'],
      ['openai->claude', './context-recovery-messages-conversion'],
      ['openai->gemini', './context-recovery-gemini-conversion'],
    ]) {
      Module._load = function(name, ...args) {
        if (name === module) throw failure;
        return load.call(this, name, ...args);
      };
      try {
        assert.throws(() => convert({label,converters:{},
          prepared:{profile:{},buffer:Buffer.from('{}')}}), error => error === failure);
        unloaded();
      } finally { Module._load = load; }
    }
    Module._load = function(name, ...args) {
      if (name === './workbuddy-context-planner') throw failure;
      return load.call(this, name, ...args);
    };
    try {
      assert.throws(() => create(prepared, '', {client}), error => error === failure);
      assert.equal(Boolean(require.cache[files[0]]), false);
    } finally { Module._load = load; }
    assert.equal(typeof create(prepared, '', {client}).request, 'function');
    for (const file of files.slice(0,3)) assert.ok(require.cache[file]);
    assert.equal(Boolean(require.cache[files[3]]), false);
    Module._load = function(name, ...args) {
      if (name === './context-recovery-wbipc-entry') throw failure;
      return load.call(this, name, ...args);
    };
    const wbipc = {prepared:{profile:{},authMode:'official-login',authProvider:'workbuddy'}};
    try {
      assert.throws(() => convert(wbipc), error => error === failure);
      assert.equal(Boolean(require.cache[files[3]]), false);
    } finally { Module._load = load; }
    assert.equal(convert(wbipc), false);
    assert.ok(require.cache[files[3]]);
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    windowsHide: true,
    env: createIsolatedTestEnv(process.env, directory),
  });
  assert.equal(result.status, 0, result.stderr);
});

test('rejected WBIPC recovery does not load legacy planning or discovery execution', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-rejected-wbipc-'));
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const script = `
    const assert = require('node:assert/strict');
    const {tryHandleContextRecoveryConvertedHttp: convert} =
      require('./lib/proxy/context-recovery-converted-http');
    const files = ['workbuddy-context-planner', 'context-tool-catalog']
      .map(name => require.resolve('./lib/proxy/' + name));
    const unloaded = () => files.forEach(file => assert.equal(Boolean(require.cache[file]), false));
    unloaded();
    for (const label of [undefined, '', 'unsupported', 'responses->chat']) {
      assert.equal(convert({label,prepared:{profile:{},authMode:'official-login',
        authProvider:'workbuddy'}}), false);
      unloaded();
    }
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    windowsHide: true,
    env: createIsolatedTestEnv(process.env, directory),
  });
  assert.equal(result.status, 0, result.stderr);
});

function fixture() {
  let qualified = 0;
  let detached = 0;
  return {
    counts: () => ({ qualified, detached }),
    options: {
      label: 'responses->chat',
      prepared: {
        profile: { protocol: 'openai' },
        rewriteTo: '-',
        buffer: Buffer.from(JSON.stringify({ model: 'model', input: 'hello' })),
      },
      target: { protocol: 'https:', hostname: 'api.openai.com', path: '/v1' },
      requestOptions: { hostname: 'api.openai.com', port: 443, method: 'POST' },
      converters: recoveryConverters(),
      providerAllowed: (scope) => {
        qualified++;
        assert.equal(scope.kind, 'chat');
        assert.equal(scope.path, '/v1/chat/completions');
        return true;
      },
      session: { ok: false },
      observer: {
        detach: () => {
          detached++;
          return true;
        },
      },
    },
  };
}

test('converted Chat recovery admits long history only from trusted format-three binding', () => {
  for (const kind of ['responses', 'claude']) {
    for (const format of [undefined, 2, 3]) {
      const { options, counts } = fixture();
      options.label = kind === 'responses' ? 'responses->chat' : 'claude->openai';
      options.session.historyFormat = format;
      options.prepared.buffer = Buffer.from(
        JSON.stringify({
          model: 'model',
          ...(kind === 'claude' ? { max_tokens: 50 } : {}),
          [kind === 'responses' ? 'input' : 'messages']: Array.from({ length: 3 }, (_, index) => ({
            role: index % 2 ? 'assistant' : 'user',
            content: 'x'.repeat(900000),
          })),
        })
      );
      assert.equal(tryHandleContextRecoveryConvertedHttp(options), false);
      assert.equal(counts().qualified, format === 3 ? 1 : 0);
      assert.equal(counts().detached, 0);
    }
  }
});

test('long-history qualification forwards trusted format to every Responses, Messages and Gemini adapter', () => {
  for (const [kind, label, upstream] of [
    ['chat', 'chat->responses', 'responses'],
    ['claude', 'claude->responses', 'responses'],
    ['chat', 'openai->claude', 'claude'],
    ['responses', 'responses->claude', 'claude'],
    ['chat', 'openai->gemini', 'gemini'],
    ['responses', 'responses->gemini', 'gemini'],
    ['claude', 'claude->gemini', 'gemini'],
  ]) {
    for (const format of [2, 3]) {
      const { options, counts } = fixture();
      let qualified = 0;
      options.label = label;
      options.session.historyFormat = format;
      options.prepared.buffer = Buffer.from(
        JSON.stringify({
          model: 'model',
          [kind === 'responses' ? 'input' : 'messages']: Array.from({ length: 3 }, (_, index) => ({
            role: index % 2 ? 'assistant' : 'user',
            content: 'x'.repeat(900000),
          })),
        })
      );
      options.providerAllowed = (scope) => {
        qualified++;
        assert.equal(scope.kind, upstream);
        return true;
      };
      assert.equal(tryHandleContextRecoveryConvertedHttp(options), false);
      assert.equal(qualified, format === 3 ? 1 : 0, label);
      assert.equal(counts().detached, 0);
    }
  }
});

test('conversion qualification precedes observer ownership and preserves ordinary unsupported routing', () => {
  const mutations = [
    (o) => {
      o.label = 'images->gemini';
    },
    (o) => {
      o.converters = null;
    },
    (o) => {
      o.prepared.authMode = 'official-login';
    },
    (o) => {
      o.prepared.activePromptPreset = { content: 'policy' };
    },
    (o) => {
      o.prepared.promptPreset = { content: 'policy' };
    },
    (o) => {
      o.prepared.profile.optimizeContext = true;
    },
    (o) => {
      o.prepared.buffer = 'bad';
    },
    (o) => {
      o.prepared.buffer = Buffer.alloc(3 * 1024 * 1024);
    },
    (o) => {
      o.prepared.buffer = Buffer.from([0xff]);
    },
    (o) => {
      o.prepared.buffer = Buffer.from('{');
    },
    (o) => {
      o.prepared.buffer = Buffer.from(
        JSON.stringify({
          model: 'model',
          input: [{ type: 'compaction', encrypted_content: 'opaque' }],
        })
      );
    },
  ];
  for (const mutate of mutations) {
    const { options, counts } = fixture();
    mutate(options);
    assert.equal(tryHandleContextRecoveryConvertedHttp(options), false);
    assert.deepEqual(counts(), { qualified: 0, detached: 0 });
  }
  const { options, counts } = fixture();
  assert.equal(tryHandleContextRecoveryConvertedHttp(options), false);
  assert.deepEqual(counts(), { qualified: 1, detached: 0 });
});

test('conversion provider qualification uses native upstream scope and rejects untrusted hosts and environment redirect', () => {
  for (const mutation of [
    (o) => {
      o.target.hostname = 'compat.example';
      o.requestOptions.hostname = 'compat.example';
    },
    (o) => {
      o.requestOptions.hostname = 'redirect.example';
    },
    (o) => {
      o.requestOptions.port = 444;
    },
    (o) => {
      o.target.protocol = 'http:';
    },
    (o) => {
      o.target.path = '/other';
    },
  ]) {
    const { options, counts } = fixture();
    delete options.providerAllowed;
    mutation(options);
    options.session = {
      get ok() {
        throw new Error('Provider was not rejected before ownership');
      },
    };
    assert.equal(tryHandleContextRecoveryConvertedHttp(options), false);
    assert.equal(counts().detached, 0);
  }
  const { options } = fixture();
  options.providerAllowed = () => false;
  assert.equal(tryHandleContextRecoveryConvertedHttp(options), false);
});

test('Responses upstream qualification checks actual route and official provenance before ownership', () => {
  for (const kind of ['chat', 'claude']) {
    const { options } = fixture();
    options.label = kind === 'chat' ? 'chat->responses' : 'claude->responses';
    options.prepared.buffer = Buffer.from(
      JSON.stringify({ model: 'model', messages: [{ role: 'user', content: 'hello' }] })
    );
    let qualified = 0;
    options.providerAllowed = (scope) => {
      qualified++;
      assert.equal(scope.kind, 'responses');
      assert.equal(scope.path, '/v1/responses');
      return true;
    };
    assert.equal(tryHandleContextRecoveryConvertedHttp(options), false);
    assert.equal(qualified, 1);
    delete options.providerAllowed;
    options.target = { protocol: 'https:', hostname: 'chatgpt.com', path: '/backend-api/codex' };
    options.requestOptions.hostname = 'chatgpt.com';
    options.prepared.authMode = 'official-login';
    options.prepared.authProvider = 'openai';
    options.session = {
      get ok() {
        throw new Error('Unqualified official source reached ownership');
      },
    };
    assert.equal(tryHandleContextRecoveryConvertedHttp(options), false);
  }
});

test('Messages upstream uses its own authentication, native path and qualified provider', () => {
  for (const kind of ['chat', 'responses']) {
    const { options, counts } = fixture();
    options.label = kind === 'chat' ? 'openai->claude' : 'responses->claude';
    options.apiKey = 'synthetic-messages-key';
    options.prepared.profile.protocol = 'claude';
    options.prepared.buffer = Buffer.from(
      JSON.stringify({
        model: 'model',
        [kind === 'chat' ? 'messages' : 'input']: [{ role: 'user', content: 'hello' }],
      })
    );
    options.target.hostname = 'api.anthropic.com';
    options.requestOptions.hostname = 'api.anthropic.com';
    options.providerAllowed = (scope) => {
      assert.equal(scope.kind, 'claude');
      assert.equal(scope.path, '/v1/messages');
      assert.equal(scope.requestOptions.headers['x-api-key'], 'synthetic-messages-key');
      assert.equal(scope.requestOptions.headers.authorization, undefined);
      assert.equal(scope.requestOptions.headers['anthropic-version'], '2023-06-01');
      return true;
    };
    assert.equal(tryHandleContextRecoveryConvertedHttp(options), false);
    for (const headers of [
      { 'anthropic-beta': 'unqualified' },
      { 'anthropic-version': 'unknown' },
    ]) {
      options.clientReq = { headers };
      options.providerAllowed = () => {
        throw Error('Unsupported contract was qualified');
      };
      assert.equal(tryHandleContextRecoveryConvertedHttp(options), false);
    }
    delete options.clientReq;
    delete options.providerAllowed;
    options.target.hostname = 'compat.example';
    options.requestOptions.hostname = 'compat.example';
    options.session = {
      get ok() {
        throw Error('Untrusted provider took ownership');
      },
    };
    assert.equal(tryHandleContextRecoveryConvertedHttp(options), false);
    assert.equal(counts().detached, 0);
  }
});

test('Gemini upstream pins native API target and authentication before observer ownership', () => {
  for (const kind of ['chat', 'responses', 'claude']) {
    const { options, counts } = fixture();
    options.label = kind === 'chat' ? 'openai->gemini' : kind + '->gemini';
    options.prepared.profile.protocol = 'gemini';
    options.prepared.rewriteTo = 'gemini-2.5-flash';
    options.prepared.buffer = Buffer.from(
      JSON.stringify({
        model: 'model',
        [kind === 'responses' ? 'input' : 'messages']: [{ role: 'user', content: 'hello' }],
      })
    );
    options.target.hostname = 'generativelanguage.googleapis.com';
    options.requestOptions.hostname = 'generativelanguage.googleapis.com';
    let qualified = 0;
    options.providerAllowed = (scope) => {
      qualified++;
      assert.equal(scope.kind, 'gemini');
      assert.equal(scope.path, '/v1beta/models/gemini-2.5-flash:generateContent');
      assert.equal(scope.requestOptions.headers.authorization, undefined);
      assert.equal(scope.requestOptions.headers['x-goog-api-key'], 'synthetic-gemini-key');
      return true;
    };
    options.apiKey = 'synthetic-gemini-key';
    assert.equal(tryHandleContextRecoveryConvertedHttp(options), false);
    assert.equal(qualified, 1);
    options.apiKey = 'ya29.synthetic';
    options.providerAllowed = (scope) => {
      assert.equal(scope.requestOptions.headers.authorization, 'Bearer ya29.synthetic');
      assert.equal(scope.requestOptions.headers['x-goog-api-key'], undefined);
      return true;
    };
    assert.equal(tryHandleContextRecoveryConvertedHttp(options), false);
    delete options.providerAllowed;
    for (const mutate of [
      (o) => {
        o.target.hostname = 'compat.example';
        o.requestOptions.hostname = 'compat.example';
      },
      (o) => {
        o.target.path = '/other';
      },
      (o) => {
        o.requestOptions.hostname = 'redirect.example';
      },
      (o) => {
        o.requestOptions.port = 444;
      },
      (o) => {
        o.prepared.authMode = 'official-login';
      },
    ]) {
      const clone = {
        ...options,
        prepared: { ...options.prepared },
        target: { ...options.target },
        requestOptions: { ...options.requestOptions },
        session: {
          get ok() {
            throw Error('Untrusted Gemini route reached ownership');
          },
        },
      };
      mutate(clone);
      assert.equal(tryHandleContextRecoveryConvertedHttp(clone), false);
    }
    assert.equal(counts().detached, 0);
  }
});
