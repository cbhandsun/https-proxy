'use strict';
const fs = require('node:fs');
const path = require('node:path');
function endpointFromLog(text) {
  if (typeof text !== 'string' || text.length > 16 * 1024 * 1024)
    throw new Error('tianxi_sdk_endpoint_invalid');
  const hosts = [
    ...new Set(
      [...text.matchAll(/https:\/\/([a-z0-9-]+)\.vpc\.qoder\.com\.cn(?=[/:\s"']|$)/g)].map(
        (m) => m[1]
      )
    ),
  ];
  if (
    hosts.length !== 1 ||
    hosts[0].length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-gateway$/.test(hosts[0])
  )
    throw new Error('tianxi_sdk_endpoint_invalid');
  return hosts[0].slice(0, -'-gateway'.length);
}
function readEndpoint() {
  const root = 'C:/ProgramData/Lenovo/AIAgent/xlagent/logs/runs';
  const files = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name, 'qodercli.log'))
    .filter((p) => fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!files.length || fs.statSync(files[0]).size > 16 * 1024 * 1024)
    throw new Error('tianxi_sdk_endpoint_invalid');
  return endpointFromLog(fs.readFileSync(files[0], 'utf8'));
}
module.exports = { endpointFromLog, readEndpoint };
