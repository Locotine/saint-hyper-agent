# Quick start

## Local development

```bash
bun install --frozen-lockfile

# Full development stack with hot reload
bun run dev

# Desktop development
bun run dev:desktop

# Desktop development on an isolated port set
SAINT_DEV_INSTANCE=feature-xyz bun run dev:desktop
```

## Production-style local run

```bash
bun run build
bun run start
```

## Desktop artifacts

```bash
# Tauri app for the current platform (Linux needs the WebKitGTK dev packages)
bun run build:desktop
```

Signed installers for every platform come from `.github/workflows/release-tauri.yml`.

## Published CLI package

The server package is published as `@saint/cli` and exposes the `saint` executable. To run an npm-published version without installing it globally:

```bash
npx --yes --package=@saint/cli saint --help
```

For repository scripts, release packaging, and multi-instance development details, see [scripts.md](./scripts.md).
