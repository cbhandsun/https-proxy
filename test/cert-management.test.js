const assert = require('assert');

const certManagementModule = require('../lib/proxy/cert-management');

const { encodePowerShellCommand, quotePowerShell } = certManagementModule._test;

assert.strictEqual(
  quotePowerShell("C:\\Path With Space\\it's.crt"),
  "'C:\\Path With Space\\it''s.crt'"
);
assert.strictEqual(quotePowerShell(null), "''");

const encoded = encodePowerShellCommand("Write-Output 'ok'");
assert.strictEqual(Buffer.from(encoded, 'base64').toString('utf16le'), "Write-Output 'ok'");
assert.strictEqual(Buffer.from(encodePowerShellCommand(null), 'base64').toString('utf16le'), '');

console.log('[cert-management.test] ok');
