# Frontend Source Governance

The frontend has one source tree and one build pipeline:

- `tauri-ui/index.html` is the only document entry.
- `tauri-ui/src/main.js` is the only JavaScript entry.
- `tauri-ui/src/modules/` contains the ESM domain modules.
- `tauri-ui/src/styles/` contains styles imported by the JavaScript entry.
- `tauri-ui/dist/` is generated exclusively by Vite and is never committed.

There are no root-level compatibility mirrors and no static copy step. Tauri
starts the Vite dev server for development and serves `tauri-ui/dist/` in
packaged builds.

Use these commands:

- `npm run frontend:dev` starts the browser development server.
- `npm run frontend:build` creates the exact frontend consumed by Tauri.
- `npm run test:frontend` verifies the source and Tauri/Vite wiring.
- `npm run dev` starts Tauri and lets its `beforeDevCommand` start Vite.
