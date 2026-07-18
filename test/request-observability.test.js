const assert = require('assert');
const { createRequestObservability } = require('../lib/proxy/request-observability');

assert.throws(() => createRequestObservability(), /requires getConfig/);

console.log('[request-observability.test] ok');
