const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const trust = require('../lib/proxy/gateway-ca-trust');
const cli = require('../scripts/install-gateway-ca');

{
  const calls = [];
  const result = trust.installGatewayCa({
    caPath: 'C:/proxy-ca-cert.pem',
    container: 'openclaw-gateway',
    readCa: () => ({ absolutePath: 'C:/proxy-ca-cert.pem', fingerprint256: 'AA:BB' }),
    runDocker(args) {
      calls.push(args);
      return { status: 0, stdout: args[0] === 'inspect' ? 'true\n' : '' };
    },
  });

  assert.strictEqual(result.container, 'openclaw-gateway');
  assert.deepStrictEqual(calls[0], ['inspect', '-f', '{{.State.Running}}', 'openclaw-gateway']);
  assert.ok(
    calls.some(
      (args) => args[0] === 'cp' && args[2] === `openclaw-gateway:${trust.CONTAINER_CA_PATH}`
    )
  );
  assert.ok(calls.some((args) => args.includes(trust.SYSTEM_CA_PATH)));
  assert.ok(calls.some((args) => args.includes('update-ca-certificates')));
  assert.ok(calls.some((args) => args.some((arg) => arg.includes(trust.GATEWAY_ENTRYPOINT_PATH))));
  assert.ok(calls.some((args) => args[0] === 'restart' && args[1] === 'openclaw-gateway'));
  assert.ok(
    calls.some(
      (args) =>
        args[0] === 'exec' &&
        args.includes('host.docker.internal') === false &&
        args.some((arg) => arg.includes("host:'host.docker.internal'"))
    )
  );
}

{
  assert.throws(() => trust.validateContainerName('bad name'), /invalid format/);
  assert.throws(
    () =>
      trust.validateCaCertificate({
        ca: false,
        fingerprint256: 'AA:BB',
        validFrom: '2020-01-01T00:00:00Z',
        validTo: '2030-01-01T00:00:00Z',
      }),
    /CA basic constraints/
  );
  assert.throws(
    () =>
      trust.validateCaCertificate(
        {
          ca: true,
          fingerprint256: 'AA:BB',
          validFrom: '2020-01-01T00:00:00Z',
          validTo: '2021-01-01T00:00:00Z',
        },
        Date.parse('2022-01-01T00:00:00Z')
      ),
    /not currently valid/
  );
  assert.throws(
    () =>
      trust.installGatewayCa({
        caPath: 'ignored',
        readCa: () => ({ absolutePath: 'ignored', fingerprint256: 'AA:BB' }),
        runDocker: () => ({ status: 0, stdout: 'false\n' }),
      }),
    /container is not running/
  );
  assert.throws(
    () =>
      trust.installGatewayCa({
        caPath: 'ignored',
        readCa: () => ({ absolutePath: 'ignored', fingerprint256: 'AA:BB' }),
        runDocker: (args) => ({ status: 0, stdout: args[0] === 'inspect' ? 'true\n' : '' }),
        verifyPort: 70000,
      }),
    /verify port/
  );
}

{
  assert.deepStrictEqual(cli.parseArgs(['--container', 'gateway', '--runtime-dir', 'C:/runtime']), {
    container: 'gateway',
    'runtime-dir': 'C:/runtime',
  });
  assert.throws(() => cli.parseArgs(['--unknown', 'value']), /unknown argument/);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-ca-runtime-'));
  try {
    assert.strictEqual(
      cli.defaultRuntimeDir({ HTTPS_PROXY_RUNTIME_DIR: temp }, 'linux'),
      path.resolve(temp)
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

console.log('[gateway-ca-trust.test] ok');
