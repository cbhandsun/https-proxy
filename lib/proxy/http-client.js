const http = require('http');
const https = require('https');
const { parseBoundedInteger, parsePortOrDefault } = require('./management-utils');

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function createHttpClient({ httpAgent, httpsAgent } = {}) {
  return function makeRequest(fullUrl, options = {}, requestBody) {
    return new Promise((resolve, reject) => {
      let parsedUrl;
      try {
        if (typeof fullUrl !== 'string') throw new TypeError('Invalid URL');
        parsedUrl = new URL(fullUrl);
        if (!['https:', 'http:'].includes(parsedUrl.protocol))
          throw new TypeError('Invalid protocol');
      } catch (e) {
        return reject(Object.assign(new Error('Invalid request URL'), { code: 'ERR_INVALID_URL' }));
      }
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;

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
        let ended = false;
        const failResponse = (error) => {
          chunks.length = 0;
          reject(error);
          req.destroy(error);
        };
        res.on('error', failResponse);
        res.on('aborted', () =>
          failResponse(
            Object.assign(new Error('Response aborted'), { code: 'ERR_RESPONSE_ABORTED' })
          )
        );
        res.on('close', () => {
          if (!ended && !tooLarge)
            failResponse(
              Object.assign(new Error('Response closed before completion'), {
                code: 'ERR_RESPONSE_ABORTED',
              })
            );
        });
        res.on('data', (chunk) => {
          if (tooLarge) return;
          bytes += chunk.length;
          if (bytes > maxResponseBytes) {
            tooLarge = true;
            chunks.length = 0;
            failResponse(
              Object.assign(
                new Error('Response body too large; max ' + maxResponseBytes + ' bytes'),
                { code: 'ERR_RESPONSE_TOO_LARGE' }
              )
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          ended = true;
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
        const error = Object.assign(
          new Error('Connection timeout (' + Math.round(reqOptions.timeout / 1000) + 's)'),
          { code: 'ETIMEDOUT' }
        );
        reject(error);
        req.destroy(error);
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
