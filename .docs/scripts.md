# Scripts

- `bun run dev` — Starts contracts, server, and web in `turbo watch` mode.
- `bun run dev:server` — Starts just the WebSocket server (uses Bun TypeScript execution).
- `bun run dev:web` — Starts just the Vite dev server for the web app.
- Dev commands default `SAINT_HOME` to `~/.saint`, which keeps dev state under `~/.saint/dev`.
- Override server CLI-equivalent flags from root dev commands with `--`, for example:
  `bun run dev -- --home-dir ~/.saint-2`
- `bun run start` — Runs the production server (serves built web app as static files).
- `bun run build` — Builds contracts, web app, and server through Turbo.
- `bun run typecheck` — Strict TypeScript checks for all packages.
- `bun run test` — Runs workspace tests.
- `bun run build:desktop` — Builds the Tauri desktop app (`apps/desktop-rust`) for the current platform.

## Development compilation

The Vite development server skips React Compiler by default so cold page loads
and edits to large chat components do not wait for compiler optimization. JSX,
TypeScript and React Fast Refresh still run through Vite's normal React plugin.
Production builds and browser tests (`test` mode) always use React Compiler.

To investigate compiler-specific behavior or compare rendering performance with
compiler memoization enabled, opt in before starting the dev server:

```bash
SAINT_DEV_REACT_COMPILER=1 bun run dev:desktop
# Also applies to bun run dev and bun run dev:web.
```

Restart the dev command after changing this flag. Default development rendering
does not have compiler-generated memoization, so use a production build or the
opt-in when measuring rendering performance.

## Desktop packaging notes

- Production icon sources are centralized in `scripts/lib/brand-assets.ts`; do not hard-code a separate packaging icon path in docs or scripts.
- The Tauri app bundles the `saint-server` sidecar (`scripts/build-server-sidecar.ts`) and starts it on loopback with an auth token for WebSocket/API traffic.
- Release signing and publication live in `.github/workflows/release-tauri.yml`; use `docs/release.md` as the source of truth for release requirements.

## Running multiple dev instances

Set `SAINT_DEV_INSTANCE` to any value to deterministically shift all dev ports together.

- Default ports: server `3773`, web `5733`
- Shifted ports: `base + offset` (offset is hashed from `SAINT_DEV_INSTANCE`)
- Example: `SAINT_DEV_INSTANCE=branch-a bun run dev:desktop`

If you want full control instead of hashing, set `SAINT_PORT_OFFSET` to a numeric offset.
