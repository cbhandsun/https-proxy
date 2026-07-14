const assert = require('assert');

const certManagementModule = require('../lib/proxy/cert-management');

const {
  buildManualTrustPendingPayload,
  buildProxyCaThumbprintsQuery,
  buildRootStoreThumbprintQuery,
  encodePowerShellCommand,
  normalizeThumbprint,
  parsePowerShellJsonArray,
  queryThumbprintInRootStores,
  quotePowerShell,
  thumbprintsFromStoreEntries,
  waitForThumbprintInRootStores,
} = certManagementModule._test;

assert.strictEqual(
  quotePowerShell("C:\\Path With Space\\it's.crt"),
  "'C:\\Path With Space\\it''s.crt'"
);
assert.strictEqual(quotePowerShell(null), "''");

const encoded = encodePowerShellCommand("Write-Output 'ok'");
assert.strictEqual(Buffer.from(encoded, 'base64').toString('utf16le'), "Write-Output 'ok'");
assert.strictEqual(Buffer.from(encodePowerShellCommand(null), 'base64').toString('utf16le'), '');
assert.strictEqual(normalizeThumbprint('ab:cd ef-12'), 'ABCDEF12');
assert.strictEqual(normalizeThumbprint(null), '');
assert.deepStrictEqual(parsePowerShellJsonArray(''), []);
assert.deepStrictEqual(parsePowerShellJsonArray('{"Thumbprint":"ab cd"}'), [
  { Thumbprint: 'ab cd' },
]);
assert.deepStrictEqual(parsePowerShellJsonArray('[{"Thumbprint":"ab cd"},{"Thumbprint":"ABCD"}]'), [
  { Thumbprint: 'ab cd' },
  { Thumbprint: 'ABCD' },
]);
assert.throws(() => parsePowerShellJsonArray('{bad json'), SyntaxError);
assert.deepStrictEqual(
  thumbprintsFromStoreEntries([
    { Thumbprint: 'ab cd' },
    { Thumbprint: 'ABCD' },
    { Thumbprint: '12:34' },
    { Thumbprint: '' },
    null,
  ]),
  ['ABCD', '1234']
);

const rootStoreQuery = buildRootStoreThumbprintQuery("ab cd'; Write-Error unsafe");
assert.ok(rootStoreQuery.includes('Cert:\\CurrentUser\\Root'));
assert.ok(rootStoreQuery.includes('Cert:\\LocalMachine\\Root'));
assert.ok(rootStoreQuery.includes('$thumbprint = '));
assert.ok(rootStoreQuery.includes(normalizeThumbprint("ab cd'; Write-Error unsafe")));
assert.ok(!rootStoreQuery.includes("ab cd'; Write-Error unsafe"));

const proxyCaQuery = buildProxyCaThumbprintsQuery();
assert.ok(proxyCaQuery.includes('CN=HTTPS Proxy Local Root CA'));
assert.ok(proxyCaQuery.includes('ConvertTo-Json -Compress'));

const pendingPayload = buildManualTrustPendingPayload(new Error('certutil timeout'));
assert.strictEqual(pendingPayload.ok, false);
assert.strictEqual(pendingPayload.pending, true);
assert.strictEqual(pendingPayload.manualTrustRequired, true);
assert.ok(pendingPayload.output.includes('系统证书导入向导'));
assert.strictEqual(pendingPayload.error, 'certutil timeout');

function execFileWithJsonResponses(responses) {
  let calls = 0;
  const execFile = (file, args, options, callback) => {
    calls += 1;
    assert.strictEqual(file, 'certutil.exe');
    assert.strictEqual(args[args.length - 2], 'Root');
    assert.strictEqual(options.windowsHide, true);
    const response = responses[Math.min(calls - 1, responses.length - 1)];
    setImmediate(() => callback(response.err || null, response.stdout || '[]'));
  };
  execFile.calls = () => calls;
  return execFile;
}

async function queryThumbprint(thumbprint, execFile) {
  return await new Promise((resolve, reject) => {
    queryThumbprintInRootStores(thumbprint, execFile, (err, trusted) => {
      if (err) reject(err);
      else resolve(trusted);
    });
  });
}

async function waitForThumbprint(thumbprint, execFile, attempts) {
  return await new Promise((resolve, reject) => {
    waitForThumbprintInRootStores(
      thumbprint,
      { execFile, attempts, delayMs: 0 },
      (err, trusted) => {
        if (err) reject(err);
        else resolve(trusted);
      }
    );
  });
}

(async () => {
  const queryExecFile = execFileWithJsonResponses([{ stdout: 'ok' }]);
  assert.strictEqual(await queryThumbprint('ab:cd', queryExecFile), true);

  const machineStoreExecFile = execFileWithJsonResponses([
    { err: new Error('not in current user') },
    { stdout: 'ok' },
  ]);
  assert.strictEqual(await queryThumbprint('ffff', machineStoreExecFile), true);

  const missingExecFile = execFileWithJsonResponses([
    { err: new Error('not in current user') },
    { err: new Error('not in local machine') },
  ]);
  assert.strictEqual(await queryThumbprint('eeee', missingExecFile), false);

  const delayedTrustedExecFile = execFileWithJsonResponses([
    { err: new Error('not yet') },
    { err: new Error('not yet') },
    { stdout: 'ok' },
  ]);
  assert.strictEqual(await waitForThumbprint('abcd', delayedTrustedExecFile, 3), true);
  assert.strictEqual(delayedTrustedExecFile.calls(), 3);

  const neverTrustedExecFile = execFileWithJsonResponses([{ err: new Error('missing') }]);
  assert.strictEqual(await waitForThumbprint('abcd', neverTrustedExecFile, 2), false);
  assert.strictEqual(neverTrustedExecFile.calls(), 4);

  console.log('[cert-management.test] ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
