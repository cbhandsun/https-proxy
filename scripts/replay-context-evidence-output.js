'use strict';

const { replayContextEvidenceOutput } = require('./lib/context-evidence-output-replay');

process.stdout.write(JSON.stringify(replayContextEvidenceOutput(), null, 2) + '\n');
