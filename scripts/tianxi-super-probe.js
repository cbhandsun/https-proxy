'use strict';

const { probeTianxiSuperMode } = require('../lib/proxy/tianxi-super-probe');

const report = probeTianxiSuperMode({
  bundlePath: process.env.HPM_TIANXI_APP_BUNDLE,
});

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
