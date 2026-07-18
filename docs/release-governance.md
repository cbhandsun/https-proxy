# Release package governance

Release builds use a clean, generated runtime under `dist/release-runtime`. The staging step installs only production dependencies from `package-lock.json`, bundles the current Node executable, and writes a runtime manifest.

## Commands

- `npm run clean:release` removes `dist/` and every Cargo `src-tauri/target*` directory after verifying that each path is inside the repository.
- `npm run clean:release:cache` removes only Cargo build caches and preserves collected installers and portable archives.
- `npm run release:prepare` recreates the Node runtime and production dependency staging directory.
- `npm run release:check` verifies the static Tauri resource and script configuration.
- `npm run tauri:build` normalizes `CARGO_TARGET_DIR` to an absolute path, builds the Tauri installers, then copies final installers and a SHA-256 manifest to `dist/release/installers`.
- `npm run release:portable` builds a clean portable directory, validates it, and creates the zip archive.

## Security rules

Published packages must never contain:

- `proxy.config.json`, `.env*`, management tokens, logs, JSONL audit files, or PID/lock files;
- `.hpm-runtime`, `.certs`, `.claude`, private keys, or symbolic links;
- npm lifecycle scripts or development dependencies.

The portable build is intentionally stateless. It ships only `proxy.config.example.json`; the application creates local state on first run. Existing portable state is never copied into a new release.
