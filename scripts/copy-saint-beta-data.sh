#!/usr/bin/env bash
# FILE: copy-saint-beta-data.sh
# Purpose: One-time move from Saint Beta to Saint (Stable) on macOS/Linux: copies
#          ~/.saint-beta/userdata (threads, projects, settings, provider sign-ins)
#          into ~/.saint/userdata. The Stable data it replaces is kept as a backup.
#          Mirrors what the in-app Stable → Beta copy takes (apps/server/src/betaImport.ts),
#          in the other direction. Shipped with the GitHub release; not app code.
# Usage: quit Saint Beta and Saint, then: bash copy-saint-beta-data.sh

set -euo pipefail

SOURCE="${SAINT_BETA_HOME:-$HOME/.saint-beta}/userdata"
TARGET_HOME="${SAINT_HOME:-$HOME/.saint}"
TARGET="$TARGET_HOME/userdata"

# Runtime entries of one install, never user data (same list as betaImport.ts).
EXCLUDED=(logs diagnostics environment-id device-boot-ownership.json server-runtime.json
  quit-resume.json import-requested.json import-result.json)

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }
fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }

[[ -f "$SOURCE/state.sqlite" ]] || fail "No Saint Beta data at $SOURCE."
[[ ! -L "$SOURCE" && ! -L "$SOURCE/state.sqlite" ]] || fail "$SOURCE must not be a link."

# The database is only consistent on disk while no app has it open.
running() {
  pgrep -x saint >/dev/null 2>&1 || pgrep -x saint-beta >/dev/null 2>&1 ||
    pgrep -f '/Saint( Beta)?\.app/Contents/MacOS/' >/dev/null 2>&1
}
if running; then
  fail "Saint or Saint Beta is still running. Quit both, then run this again."
fi

mkdir -p "$TARGET_HOME"
if [[ -e "$TARGET" ]]; then
  backup="$TARGET.before-beta-copy-$(date +%Y%m%d-%H%M%S)"
  mv "$TARGET" "$backup"
  say "Kept the previous Saint data at $backup"
fi

staging="$(mktemp -d "$TARGET_HOME/.beta-copy-XXXXXX")"
trap 'rm -rf "$staging"' EXIT
for entry in "$SOURCE"/* "$SOURCE"/.[!.]*; do
  [[ -e "$entry" ]] || continue
  name="$(basename "$entry")"
  for excluded in "${EXCLUDED[@]}"; do [[ "$name" == "$excluded" ]] && continue 2; done
  # -shm is a rebuildable index; a stale one must not sit next to the copied WAL.
  [[ "$name" == state.sqlite-shm ]] && continue
  cp -R "$entry" "$staging/$name"
done
mv "$staging" "$TARGET"
trap - EXIT

say "Copied Saint Beta data into $TARGET. Open Saint to continue where Beta left off."
