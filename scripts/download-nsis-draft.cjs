'use strict';

require('./lib/nsis-draft-download')
  .runDraftDownload(process.env)
  .catch(() => {
    process.stderr.write('baseline_draft_download_refused\n');
    process.exitCode = 1;
  });
