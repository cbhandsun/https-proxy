'use strict';

const { resolveReviewRoute } = require('./lib/nsis-review-route');
try {
  if (process.argv.length !== 3) throw new Error('nsis_review_route_refused');
  resolveReviewRoute(process.argv[2], process.env);
  process.stdout.write('nsis_review_route_resolved\n');
} catch {
  process.stderr.write('nsis_review_route_refused\n');
  process.exitCode = 1;
}
