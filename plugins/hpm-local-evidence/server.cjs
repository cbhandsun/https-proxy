'use strict';

const { startContextEvidencePlugin } = require('./runtime/lib/client/context-evidence-mcp');
startContextEvidencePlugin().catch(() => {
  process.stderr.write('evidence_mcp_start_failed\n');
  process.exitCode = 1;
});
