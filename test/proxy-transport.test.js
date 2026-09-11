const assert = require('assert');
const http = require('http');
const {
  createSocksProxyAgentFactory,
  createProxyTransport,
  normalizeTimeout,
  shouldBypassProxy,
  MAX_BUFFERED_BODY_BYTES,
} = require('../lib/proxy/proxy-transport');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function performRequest(requestWithProxy, targetUrl, options, body) {
  return new Promise((resolve, reject) => {
    const request = requestWithProxy(targetUrl, options, (response) => {
      let responseBody = '';
      response.on('data', (chunk) => (responseBody += chunk));
      response.on('end', () => resolve({ response, body: responseBody }));
    });
    request.once('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function main() {
  let socksModuleLoads = 0;
  class FakeSocksProxyAgent {
    constructor(url, options) {
      this.url = url;
      this.options = options;
    }
  }
  const createFakeSocksAgent = createSocksProxyAgentFactory(() => {
    socksModuleLoads += 1;
    return { SocksProxyAgent: FakeSocksProxyAgent };
  });
  const firstSocksAgent = createFakeSocksAgent('socks5://127.0.0.1:1080', { timeout: 10 });
  const secondSocksAgent = createFakeSocksAgent('socks5://127.0.0.1:1081', { timeout: 20 });
  assert.ok(firstSocksAgent instanceof FakeSocksProxyAgent);
  assert.ok(secondSocksAgent instanceof FakeSocksProxyAgent);
  assert.strictEqual(socksModuleLoads, 1);
  assert.ok(createSocksProxyAgentFactory()('socks5://127.0.0.1:1080'));
  assert.throws(() => createSocksProxyAgentFactory('invalid'), /loader must be a function/);
  assert.throws(
    () => createSocksProxyAgentFactory(() => ({}))('socks5://127.0.0.1:1080'),
    /must export SocksProxyAgent/
  );

  assert.strictEqual(normalizeTimeout(undefined), 0);
  assert.strictEqual(normalizeTimeout('invalid'), 0);
  assert.strictEqual(normalizeTimeout(-1), 0);
  assert.strictEqual(normalizeTimeout(Infinity), 0);
  assert.strictEqual(normalizeTimeout(999_999), 300_000);
  assert.strictEqual(shouldBypassProxy(new URL('http://127.0.0.1:8080'), {}), true);
  assert.strictEqual(
    shouldBypassProxy(new URL('http://api.example.test'), { NO_PROXY: '.example.test' }),
    true
  );
  assert.strictEqual(
    shouldBypassProxy(new URL('http://api.example.test:8080'), { NO_PROXY: 'api.example.test:80' }),
    false
  );

  let directBody = '';
  const directServer = http.createServer((request, response) => {
    request.on('data', (chunk) => (directBody += chunk));
    request.on('end', () => response.end('direct-ok'));
  });
  const directPort = await listen(directServer);
  const directTransport = createProxyTransport({
    environment: {},
    loadConfig: () => ({ appSettings: { disableLocalProxy: true } }),
    proxyPorts: [],
    loadSocksProxyAgentModule: () => {
      throw new Error('SOCKS dependency must remain lazy for direct requests');
    },
  });
  const directResult = await performRequest(
    directTransport.requestWithProxy,
    `http://127.0.0.1:${directPort}/submit`,
    { method: 'POST', headers: { 'content-type': 'text/plain' } },
    Buffer.from('buffered-body')
  );
  assert.strictEqual(directResult.body, 'direct-ok');
  assert.strictEqual(directBody, 'buffered-body');
  await close(directServer);

  let proxyRequest = null;
  const proxyServer = http.createServer((request, response) => {
    proxyRequest = { url: request.url, authorization: request.headers['proxy-authorization'] };
    response.end('proxy-ok');
  });
  const proxyPort = await listen(proxyServer);
  const proxiedTransport = createProxyTransport({
    environment: { HTTP_PROXY: `http://user:pass@127.0.0.1:${proxyPort}` },
    loadConfig: () => ({}),
    proxyPorts: [],
  });
  const proxyResult = await performRequest(
    proxiedTransport.requestWithProxy,
    'http://example.test/path?q=1',
    { method: 'GET' }
  );
  assert.strictEqual(proxyResult.body, 'proxy-ok');
  assert.strictEqual(proxyRequest.url, 'http://example.test/path?q=1');
  assert.strictEqual(proxyRequest.authorization, 'Basic dXNlcjpwYXNz');
  await close(proxyServer);

  const invalidError = await new Promise((resolve) => {
    const request = directTransport.requestWithProxy('file:///tmp/secret', {}, () => {});
    request.once('error', resolve);
    request.end();
  });
  assert.match(invalidError.message, /http: or https:/);

  const credentialsError = await new Promise((resolve) => {
    const request = directTransport.requestWithProxy(
      'http://user:pass@example.test/',
      {},
      () => {}
    );
    request.once('error', resolve);
    request.end();
  });
  assert.match(credentialsError.message, /must not include credentials/);

  const stalledServer = http.createServer(() => {});
  const stalledPort = await listen(stalledServer);
  const timeoutError = await new Promise((resolve) => {
    const request = directTransport.requestWithProxy(
      `http://127.0.0.1:${stalledPort}/stall`,
      { timeout: 30 },
      () => {}
    );
    request.once('error', resolve);
    request.end();
  });
  assert.match(timeoutError.message, /Request timeout/);
  await close(stalledServer);

  const overflowServer = http.createServer(() => {});
  const overflowPort = await listen(overflowServer);
  const overflowError = await new Promise((resolve) => {
    const request = directTransport.requestWithProxy(
      `http://127.0.0.1:${overflowPort}/overflow`,
      { method: 'POST' },
      () => {}
    );
    request.once('error', resolve);
    assert.strictEqual(request.write(Buffer.alloc(MAX_BUFFERED_BODY_BYTES + 1)), false);
  });
  assert.match(overflowError.message, /too large/);
  await close(overflowServer);

  console.log('[proxy-transport.test] ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
