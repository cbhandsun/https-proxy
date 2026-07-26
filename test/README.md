# Test Layout

- `frontend/`: frontend architecture, dependency-boundary, external-response,
  runtime-primitive and DOM rendering tests. Run with `npm run test:frontend`.
- `governance/`: CI, lint, architecture and release-policy tests.
- Root `*.test.js`: proxy, protocol, security, release and runtime unit tests
  selected by `scripts/run-unit-tests.js`.
- `headers-routing.test.js` and `entry-auth-integration.test.js`: integration
  tests run by `npm run test:integration`.
- `thinking-persistence.test.js`: persistence-focused test with its own package
  script.
- `env-tools.test.js` and `tool-configs.test.js`: environment tests with their
  own package script.

Every `*.test.js` file must be classified in `scripts/run-unit-tests.js`.
Frontend tests are intentionally classified as non-unit tests because
`scripts/run-frontend-tests.js` owns their execution.
