'use strict';

const fs = require('node:fs');
const { isMainThread } = require('node:worker_threads');

// Synthetic process-only preload: a nested worker must never replay it.
if (!isMainThread) throw new Error('synthetic_worker_preload_replayed');
if (!fs.readFileSync(0).equals(Buffer.from('1'))) throw new Error('synthetic_preload_rejected');
