# Frontend Source Governance

The frontend has one source tree and one build pipeline:

- `tauri-ui/index.html` is the only document entry.
- `tauri-ui/src/main.js` is the only JavaScript entry.
- `tauri-ui/src/app/bootstrap.js` is the application composition root.
- `tauri-ui/src/app/domains/` contains independently configured ESM domain
  modules.
- `tauri-ui/src/app/runtime/` contains dependency-free state, DOM, dependency
  binding and performance primitives.
- `tauri-ui/src/app/ux.js` owns the shared browser UX boundary.
- `tauri-ui/src/styles/` contains styles imported by the JavaScript entry.
- `tauri-ui/dist/` is generated exclusively by Vite and is never committed.

There are no root-level compatibility mirrors and no static copy step. Tauri
starts the Vite dev server for development and serves `tauri-ui/dist/` in
packaged builds.

Domain modules must not import the bootstrap or each other. The bootstrap passes
explicit runtime dependencies through each domain's `configure*()` boundary, and
the architecture gate rejects ESM cycles. Runtime modules may not import project
modules. The bootstrap has a test-enforced, non-increasing line budget so new
features must live in a domain or runtime module.

Use these commands:

- `npm run frontend:dev` starts the browser development server.
- `npm run check:architecture` validates source placement and dependency
  direction.
- `npm run clean:frontend` removes current and obsolete frontend output only.
- `npm run frontend:build` validates, cleans and creates the exact frontend
  consumed by Tauri.
- `npm run test:frontend` verifies the source and Tauri/Vite wiring.
- `npm run dev` starts Tauri and lets its `beforeDevCommand` start Vite.
