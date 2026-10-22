'use strict';

const { replayNativeEvidenceReadback } = require('./lib/native-evidence-readback-replay');

process.stdout.write(JSON.stringify(replayNativeEvidenceReadback(), null, 2) + '\n');
