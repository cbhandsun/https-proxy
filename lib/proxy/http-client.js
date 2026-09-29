const http = require('http');
const https = require('https');
const { parseBoundedInteger, parsePortOrDefault } = require('./management-utils');

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function createHttpClient({ httpAgent, httpsAgent } = {}) {
  return function makeRequest(fullUrl, options = {}, requestBody) {
    return new Promise((resolve, reject) => {
      const isHttps = fullUrl.startsWith('https:');
      const lib = isHttps ? https : http;
      let parsedUrl;
      try {
        parsedUrl = new URL(fullUrl);
      } catch (e) {
        return reject(new Error('Invalid URL: ' + fullUrl));
      }

      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsePortOrDefault(parsedUrl.port, isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: parseBoundedInteger(options.timeout, 10000, 100, 10 * 60 * 1000),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      const maxResponseBytes = parseBoundedInteger(
        options.maxResponseBytes,
        DEFAULT_MAX_RESPONSE_BYTES,
        1,
        MAX_RESPONSE_BYTES
      );

      if (isHttps) {
        reqOptions.agent = httpsAgent;
      } else {
        reqOptions.agent = httpAgent;
      }

      const req = lib.request(reqOptions, (res) => {
        const chunks = [];
        let bytes = 0;
        let tooLarge = false;
        res.on('data', (chunk) => {
          if (tooLarge) return;
          bytes += chunk.length;
          if (bytes > maxResponseBytes) {
            tooLarge = true;
            chunks.length = 0;
            req.destroy(new Error('Response body too large; max ' + maxResponseBytes + ' bytes'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (tooLarge) return;
          const bodyStr = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: bodyStr,
          });
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Connection timeout (' + Math.round(reqOptions.timeout / 1000) + 's)'));
      });

      if (requestBody) {
        req.write(requestBody);
      }
      req.end();
    });
  };
}

module.exports = {
  createHttpClient,
};
