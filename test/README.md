# Test Layout

- `frontend/`: frontend architecture, dependency-boundary, external-response,
  runtime-primitive and DOM rendering tests. Run with `npm run test:frontend`.
- `governance/`: CI, lint, architecture and release-policy tests.
- Root and nested `*.test.js`: proxy, protocol, security, release and runtime
  unit tests discovered recursively by `scripts/run-unit-tests.js`.
- `headers-routing.test.js` and `entry-auth-integration.test.js`: integration
  tests run by `npm run test:integration`.
- `thinking-persistence.test.js`: persistence-focused test with its own package
  script.
- `env-tools.test.js` and `tool-configs.test.js`: environment tests with their
  own package script.

New tests join the unit gate automatically. Only tests with a dedicated package
script or runner are excluded explicitly. `test/frontend/` is excluded by
directory convention because `scripts/run-frontend-tests.js` owns its execution.

All spawned proxy processes must use temporary config and runtime directories.
`npm run clean:test-runtime` removes legacy ignored runtime files from `test/`;
normal test execution must leave that directory unchanged.
