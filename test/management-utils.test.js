const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const {
  fileSignature,
  installManagementCorsGuard,
  isAllowedManagementOrigin,
  isLocalManagementPath,
  isQuietLocalPollRequest,
  parseBoundedInteger,
  parsePortOrDefault,
  PRIVATE_FILE_MODE,
  readJsonBodyFromRequest,
  readLastLinesOfJsonl,
  readTextBodyFromResponse,
  writeJsonFileAtomically,
  writeJsonFileAtomicallyAsync,
  writeTextFileAtomically,
} = require('../lib/proxy/management-utils');
const {
  normalizePromptPresets,
  writeTextFileAtomically: writePromptTextFileAtomically,
} = require('../lib/proxy/prompts-sync');

async function readJsonFromChunks(chunks, options) {
  return new Promise((resolve, reject) => {
    readJsonBodyFromRequest(
      Readable.from(chunks),
      (err, body) => (err ? reject(err) : resolve(body)),
      options
    );
  });
}

async function readJsonErrorFromChunks(chunks, options) {
  return new Promise((resolve) => {
    readJsonBodyFromRequest(Readable.from(chunks), (err) => resolve(err), options);
  });
}

async function readTextFromChunks(chunks, options) {
  return new Promise((resolve, reject) => {
    readTextBodyFromResponse(
      Readable.from(chunks),
      (err, text) => (err ? reject(err) : resolve(text)),
      options
    );
  });
}

async function readTextErrorFromChunks(chunks, options) {
  return new Promise((resolve) => {
    readTextBodyFromResponse(Readable.from(chunks), (err) => resolve(err), options);
  });
}

(async () => {
  assert.strictEqual(parseBoundedInteger('42', 5, 1, 100), 42);
  assert.strictEqual(parseBoundedInteger('not-a-number', 5, 1, 100), 5);
  assert.strictEqual(parseBoundedInteger('-10', 5, 1, 100), 1);
  assert.strictEqual(parseBoundedInteger('9999', 5, 1, 100), 100);
  assert.strictEqual(parsePortOrDefault('not-a-port', 3443), 3443);

  assert.deepStrictEqual(await readJsonFromChunks([Buffer.from('{"ok":true}')], { maxBytes: 64 }), {
    ok: true,
  });
  const tooLargeJson = await readJsonErrorFromChunks([Buffer.alloc(8), Buffer.alloc(8)], {
    maxBytes: 10,
  });
  assert.match(tooLargeJson.message, /Request body too large/);

  assert.strictEqual(
    await readTextFromChunks([Buffer.from('hello'), Buffer.from(' world')], { maxBytes: 64 }),
    'hello world'
  );
  const tooLargeText = await readTextErrorFromChunks([Buffer.alloc(8), Buffer.alloc(8)], {
    maxBytes: 10,
  });
  assert.match(tooLargeText.message, /Response body too large/);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-management-utils-'));
  try {
    const textTarget = path.join(tmpDir, 'nested', 'notes.txt');
    writeTextFileAtomically(textTarget, 'first');
    assert.strictEqual(fs.readFileSync(textTarget, 'utf8'), 'first');
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(textTarget).mode & 0o777, PRIVATE_FILE_MODE);
    }
    writeTextFileAtomically(textTarget, 'second');
    assert.strictEqual(fs.readFileSync(textTarget, 'utf8'), 'second');

    const jsonTarget = path.join(tmpDir, 'config', 'settings.json');
    writeJsonFileAtomically(jsonTarget, { ok: true, count: 2 });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(jsonTarget, 'utf8')), {
      ok: true,
      count: 2,
    });
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(jsonTarget).mode & 0o777, PRIVATE_FILE_MODE);
    }

    await writeJsonFileAtomicallyAsync(jsonTarget, { ok: true, count: 3 });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(jsonTarget, 'utf8')), { ok: true, count: 3 });
    assert.deepStrictEqual(fs.readdirSync(path.dirname(jsonTarget)), ['settings.json']);
    const circular = {};
    circular.self = circular;
    await assert.rejects(writeJsonFileAtomicallyAsync(jsonTarget, circular), TypeError);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(jsonTarget, 'utf8')), { ok: true, count: 3 });
    const directoryTarget = path.join(tmpDir, 'directory-target');
    fs.mkdirSync(directoryTarget);
    await assert.rejects(writeJsonFileAtomicallyAsync(directoryTarget, {}));
    assert.equal(fs.statSync(directoryTarget).isDirectory(), true);
    assert.equal(
      fs.readdirSync(tmpDir).some((name) => name.endsWith('.tmp')),
      false
    );
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(jsonTarget).mode & 0o777, PRIVATE_FILE_MODE);
    }

    assert.deepStrictEqual(
      normalizePromptPresets([{ id: ' daily ', name: 'Daily', content: 'hello {{cwd}}' }]),
      [{ id: 'daily', name: 'Daily', content: 'hello {{cwd}}' }]
    );
    assert.throws(() => normalizePromptPresets('bad'), /presets must be an array/);
    assert.throws(
      () =>
        normalizePromptPresets(
          Array.from({ length: 65 }, (_, i) => ({ id: `p${i}`, content: 'x' }))
        ),
      /too many items/
    );
    assert.throws(() => normalizePromptPresets([{ id: '', content: 'x' }]), /id is required/);
    assert.throws(
      () => normalizePromptPresets([{ id: 'too-large', content: 'x'.repeat(200001) }]),
      /content is too large/
    );

    const promptTarget = path.join(tmpDir, 'prompts', 'CLAUDE.md');
    writePromptTextFileAtomically(promptTarget, 'first');
    assert.strictEqual(fs.readFileSync(promptTarget, 'utf8'), 'first');
    writePromptTextFileAtomically(promptTarget, 'second');
    assert.strictEqual(fs.readFileSync(promptTarget, 'utf8'), 'second');

    const leftoverTmpFiles = [];
    for (const dir of [
      path.dirname(textTarget),
      path.dirname(jsonTarget),
      path.dirname(promptTarget),
    ]) {
      leftoverTmpFiles.push(...fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')));
    }
    assert.deepStrictEqual(leftoverTmpFiles, []);

    const jsonlTarget = path.join(tmpDir, 'events.jsonl');
    fs.writeFileSync(
      jsonlTarget,
      [
        JSON.stringify({ index: 1 }),
        JSON.stringify({ index: 2 }),
        JSON.stringify({ index: 3 }),
        '',
      ].join('\n')
    );
    assert.notStrictEqual(fileSignature(jsonlTarget), 'missing');
    assert.deepStrictEqual(
      readLastLinesOfJsonl(jsonlTarget, 2).map((item) => item.index),
      [2, 3]
    );
    assert.deepStrictEqual(
      readLastLinesOfJsonl(jsonlTarget, -10).map((item) => item.index),
      [3]
    );

    const manyJsonlTarget = path.join(tmpDir, 'many-events.jsonl');
    fs.writeFileSync(
      manyJsonlTarget,
      Array.from({ length: 5005 }, (_, index) => JSON.stringify({ index })).join('\n') + '\n'
    );
    const many = readLastLinesOfJsonl(manyJsonlTarget, 999999, 4 * 1024 * 1024);
    assert.strictEqual(many.length, 5000);
    assert.strictEqual(many[0].index, 5);
    assert.strictEqual(many[4999].index, 5004);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  assert.strictEqual(isLocalManagementPath('/v1/local/config'), true);
  assert.strictEqual(isLocalManagementPath('/local/events?after=1'), true);
  assert.strictEqual(isLocalManagementPath('/v1/messages'), false);
  assert.strictEqual(isQuietLocalPollRequest('GET', '/v1/local/cli/sessions'), true);
  assert.strictEqual(isQuietLocalPollRequest('HEAD', '/local/events'), true);
  assert.strictEqual(isQuietLocalPollRequest('GET', '/v1/local/log'), true);
  assert.strictEqual(isQuietLocalPollRequest('GET', '/v1/local/audit/conversations'), true);
  assert.strictEqual(isQuietLocalPollRequest('GET', '/v1/local/usage/report'), true);
  assert.strictEqual(isQuietLocalPollRequest('POST', '/v1/local/config'), false);
  assert.strictEqual(isQuietLocalPollRequest('GET', '/v1/messages'), false);

  assert.strictEqual(isAllowedManagementOrigin('http://localhost:1430'), true);
  assert.strictEqual(isAllowedManagementOrigin('https://127.0.0.1:3443'), true);
  assert.strictEqual(isAllowedManagementOrigin('tauri://localhost'), true);
  assert.strictEqual(isAllowedManagementOrigin('https://example.com'), false);
  assert.strictEqual(isAllowedManagementOrigin('null'), false);

  const corsHeaders = {};
  const corsRes = {
    setHeader(key, value) {
      corsHeaders[key] = value;
    },
    writeHead(statusCode, nextHeaders) {
      corsHeaders.statusCode = statusCode;
      Object.assign(corsHeaders, nextHeaders || {});
    },
  };
  assert.strictEqual(
    installManagementCorsGuard({ headers: { origin: 'tauri://localhost' } }, corsRes),
    true
  );
  assert.ok(corsHeaders['Access-Control-Allow-Headers'].includes('x-mgmt-token'));

  console.log('[management-utils.test] ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
