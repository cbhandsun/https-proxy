'use strict';

const { prepareLocalEvidencePlugin } = require('./lib/local-evidence-plugin-build');

if (require.main === module)
  prepareLocalEvidencePlugin()
    .then((report) => process.stdout.write(JSON.stringify(report) + '\n'))
    .catch(() => {
      process.stderr.write('local_evidence_bundle_failed\n');
      process.exitCode = 1;
    });

module.exports = { prepareLocalEvidencePlugin };
