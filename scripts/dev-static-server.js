const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.env.PORT || 1430);
const root = path.resolve(__dirname, '..', 'tauri-ui');

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    ...headers,
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const pathname = decodeURIComponent(url.pathname === '/' ? '/electron-ui.html' : url.pathname);
    const requested = path.normalize(path.join(root, pathname));

    if (!requested.startsWith(root)) {
      send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    fs.readFile(requested, (err, data) => {
      if (err) {
        send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
        return;
      }
      const ext = path.extname(requested).toLowerCase();
      send(res, 200, data, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
    });
  } catch (err) {
    send(res, 500, String(err && err.message ? err.message : err), { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`HTTPS Proxy Manager dev static server listening at http://localhost:${port}`);
  console.log(`Serving: ${root}`);
});
