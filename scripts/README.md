# Script Entry Points

Scripts are kept at one level because several are user-facing commands and
release workflows call them by path. Their prefixes and package scripts define
their role:

- `check-*`: CI, syntax, coverage and release gates.
- `run-*`: test runners.
- `build-*`, `collect-*`, `prepare-*`, `validate-*`, `verify-*`, `smoke-test-*`:
  release pipeline.
- `clean-generated-artifacts.js`: bounded cleanup for frontend, release and
  Cargo output. Release paths are split between disposable `dist/staging` and
  publishable `dist/artifacts`; `dist/archive` is preserved.
- `install-*`, `kill-*`: local operational helpers.
- `patch-trae-*`, `unpatch-trae-*`, `trae-*`: Trae diagnostics documented in
  `docs/trae-official-bridge*.md`.

Prefer package scripts for supported workflows. Direct script invocation is
reserved for diagnostics and release internals.
