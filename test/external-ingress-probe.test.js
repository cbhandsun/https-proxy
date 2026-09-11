const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  classifyRequestError,
  classifyResponse,
  isPublicIpAddress,
  parseExternalIngressUrl,
  probeExternalIngress,
  resolvePublicAddresses,
} = require('../lib/proxy/external-ingress-probe');

{
  const parsed = parseExternalIngressUrl('https://api.example.test/v1/chat/completions');
  assert.equal(parsed.baseUrl, 'https://api.example.test/v1');
  assert.equal(parsed.probeUrl, 'https://api.example.test/v1/.well-known/hpm-health');
  assert.equal(
    parseExternalIngressUrl('https://api.example.test').baseUrl,
    'https://api.example.test/v1'
  );

  for (const value of [
    '',
    'not-a-url',
    'http://api.example.test/v1',
    'https://user:pass@api.example.test/v1',
    'https://api.example.test:8443/v1',
    'https://api.example.test/v1?token=secret',
    'https://api.example.test/private/path',
  ]) {
    assert.throws(() => parseExternalIngressUrl(value));
  }
}

{
  assert.equal(isPublicIpAddress('211.99.101.104'), true);
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.168.1.1',
    '198.51.100.10',
    '::1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    'invalid',
  ]) {
    assert.equal(isPublicIpAddress(address), false, `${address} must not be probeable`);
  }
}

(async () => {
  const publicRecords = await resolvePublicAddresses('api.example.test', async () => [
    { address: '211.99.101.104', family: 4 },
  ]);
  assert.deepEqual(publicRecords, [{ address: '211.99.101.104', family: 4 }]);

  await assert.rejects(
    resolvePublicAddresses('api.example.test', async () => [
      { address: '211.99.101.104', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    /only to public addresses/
  );
  await assert.rejects(
    resolvePublicAddresses('api.example.test', async () => []),
    /no usable addresses/
  );
  await assert.rejects(resolvePublicAddresses('127.0.0.1'), /host must be public/);

  assert.deepEqual(
    classifyResponse({
      statusCode: 200,
      headers: { 'x-hpm-proxy': 'https-proxy-manager' },
      body: '{}',
    }),
    {
      ok: true,
      proxyReached: true,
      classification: 'proxy_reached',
      message: '外部入口已到达 HTTPS Proxy Manager',
    }
  );
  assert.equal(
    classifyResponse({
      statusCode: 404,
      headers: { server: 'nginx', 'content-type': 'text/plain' },
      body: '404 page not found',
    }).classification,
    'ingress_route_missing'
  );
  assert.equal(
    classifyResponse({ statusCode: 502, headers: {}, body: '' }).classification,
    'ingress_upstream_unavailable'
  );
  assert.equal(
    classifyResponse({
      statusCode: 401,
      headers: { 'x-request-id': 'safe-request-id' },
      body: '{}',
    }).classification,
    'legacy_proxy_reached'
  );
  assert.equal(classifyRequestError({ code: 'ETIMEDOUT' }).classification, 'timeout');
  assert.equal(classifyRequestError({ code: 'CERT_HAS_EXPIRED' }).classification, 'tls_error');

  let capturedOptions;
  function successRequestFactory(_url, options, callback) {
    capturedOptions = options;
    const request = new EventEmitter();
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {
        'content-type': 'application/json; charset=utf-8',
        'x-hpm-proxy': 'https-proxy-manager',
        'x-request-id': 'req-test',
      };
      callback(response);
      queueMicrotask(() => {
        response.emit('data', Buffer.from('{"ok":true}'));
        response.emit('end');
      });
    };
    request.destroy = (error) => request.emit('error', error);
    return request;
  }

  const success = await probeExternalIngress('https://api.example.test/v1', {
    lookup: async () => [{ address: '211.99.101.104', family: 4 }],
    requestFactory: successRequestFactory,
  });
  assert.equal(success.ok, true);
  assert.equal(success.proxyReached, true);
  assert.equal(success.classification, 'proxy_reached');
  assert.equal(success.statusCode, 200);
  assert.equal(success.response.requestId, 'req-test');
  assert.equal(capturedOptions.headers.authorization, undefined);
  assert.equal(capturedOptions.headers['x-api-key'], undefined);
  await new Promise((resolve, reject) => {
    capturedOptions.lookup('api.example.test', {}, (error, address, family) => {
      if (error) return reject(error);
      assert.equal(address, '211.99.101.104');
      assert.equal(family, 4);
      resolve();
    });
  });
  await new Promise((resolve, reject) => {
    capturedOptions.lookup('api.example.test', { all: true }, (error, addresses) => {
      if (error) return reject(error);
      assert.deepEqual(addresses, [{ address: '211.99.101.104', family: 4 }]);
      resolve();
    });
  });

  function failedRequestFactory() {
    const request = new EventEmitter();
    request.end = () => {
      const error = new Error('connection refused');
      error.code = 'ECONNREFUSED';
      queueMicrotask(() => request.emit('error', error));
    };
    request.destroy = (error) => request.emit('error', error);
    return request;
  }
  const failure = await probeExternalIngress('https://api.example.test/v1', {
    lookup: async () => [{ address: '211.99.101.104', family: 4 }],
    requestFactory: failedRequestFactory,
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.classification, 'connection_error');
  assert.equal(failure.errorCode, 'ECONNREFUSED');

  const dnsFailure = await probeExternalIngress('https://missing.example.test/v1', {
    lookup: async () => {
      const error = new Error('not found');
      error.code = 'ENOTFOUND';
      throw error;
    },
  });
  assert.equal(dnsFailure.ok, false);
  assert.equal(dnsFailure.classification, 'dns_error');
  assert.equal(dnsFailure.errorCode, 'ENOTFOUND');

  await assert.rejects(probeExternalIngress('https://127.0.0.1/v1'), /host must be public/);

  console.log('[external-ingress-probe.test] ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
