const http = require('http');
const https = require('https');

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
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: Number(options.timeout) || 10000,
      };

      if (isHttps) {
        reqOptions.agent = httpsAgent;
      } else {
        reqOptions.agent = httpAgent;
      }

      const req = lib.request(reqOptions, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const bodyStr = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: bodyStr
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
