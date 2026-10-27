#!/usr/bin/env bash
# FILE: install-saint.sh
# Purpose: Installs a Saint AppImage as a desktop app on Ubuntu/Debian: a fixed
#          ~/Applications/saint.AppImage that the in-app updater overwrites, plus the
#          menu entry, icon, and saint:// link handler. Shipped with every GitLab release.
# Usage: bash install-saint.sh [path/to/Saint-*.AppImage]   (default: newest in ~/Downloads)
#        bash install-saint.sh --uninstall                 (data in ~/.saint stays)

set -euo pipefail

APP_DIR="$HOME/Applications"
APP_IMAGE="$APP_DIR/saint.AppImage"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP_FILE="$DESKTOP_DIR/saint.desktop"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/1024x1024/apps"
ICON_PATH="usr/share/icons/hicolor/1024x1024/apps/saint.png"

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }
fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }
confirm() {
  local reply
  read -r -p "$1 [y/N] " reply </dev/tty 2>/dev/null || return 1
  [[ "$reply" =~ ^[Yy]$ ]]
}
refresh_menu() {
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  fi
}

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$APP_IMAGE" "$DESKTOP_FILE" "$ICON_DIR/saint.png"
  refresh_menu
  say "Removed Saint. Your data in ~/.saint is kept."
  exit 0
fi

[[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]] || fail "This build is for Linux x86_64."

source_image="${1:-}"
if [[ -z "$source_image" ]]; then
  # Saint-<version>-x86_64.AppImage; Saint-Beta-* is a different app.
  source_image="$(ls -t "$HOME"/Downloads/Saint-[0-9]*.AppImage 2>/dev/null | head -n 1 || true)"
  [[ -n "$source_image" ]] || fail "No Saint-<version>-x86_64.AppImage in ~/Downloads. Pass its path."
fi
[[ -f "$source_image" ]] || fail "$source_image does not exist."

if pgrep -x saint >/dev/null 2>&1; then
  fail "Saint is running. Quit it, then run this again."
fi

# AppImages mount themselves through FUSE 2, which Ubuntu 22.04+ no longer installs by default.
if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
  fuse_package=libfuse2
  if apt-cache show libfuse2t64 >/dev/null 2>&1; then fuse_package=libfuse2t64; fi
  say "AppImages need $fuse_package."
  if confirm "Install $fuse_package with sudo apt now?"; then
    sudo apt-get install -y "$fuse_package"
  else
    fail "Install it with: sudo apt install $fuse_package"
  fi
fi

# A .deb install would show a second menu entry and never update. Builds from
# before the rename were packaged under the upstream name, matched exactly here
# (a looser prefix would also catch unrelated packages such as syncthing).
if command -v dpkg-query >/dev/null 2>&1; then
  deb_packages="$(dpkg-query -W -f='${Package} ${Status}\n' 2>/dev/null \
    | awk '/install ok installed/ && tolower($1) ~ /^(saint|synara)([-_.]|$)/ { print $1 }' || true)"
  if [[ -n "$deb_packages" ]]; then
    say "Found installed .deb package(s): $(echo "$deb_packages" | tr '\n' ' ')"
    if confirm "Remove them with sudo apt (your data in ~/.saint and ~/.saint-beta stays)?"; then
      # shellcheck disable=SC2086
      sudo apt-get remove -y $deb_packages
    fi
  fi
fi

say "Installing $(basename "$source_image") to $APP_IMAGE"
mkdir -p "$APP_DIR" "$DESKTOP_DIR" "$ICON_DIR"
if [[ "$(realpath "$source_image")" != "$(realpath -m "$APP_IMAGE")" ]]; then
  install -m 755 "$source_image" "$APP_IMAGE.partial"
  mv -f "$APP_IMAGE.partial" "$APP_IMAGE"
fi
chmod 755 "$APP_IMAGE"

extract_dir="$(mktemp -d)"
trap 'rm -rf "$extract_dir"' EXIT
(cd "$extract_dir" && "$APP_IMAGE" --appimage-extract "$ICON_PATH" >/dev/null 2>&1) || true
if [[ -f "$extract_dir/squashfs-root/$ICON_PATH" ]]; then
  cp "$extract_dir/squashfs-root/$ICON_PATH" "$ICON_DIR/saint.png"
else
  say "Could not extract the icon; the menu entry uses a generic one."
fi

# `--no-sandbox` matches the entry electron-builder ships inside the AppImage: Ubuntu 24.04
# blocks Chromium's sandbox for apps run from an AppImage mount.
cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Name=Saint
Comment=Saint desktop build
Exec="$APP_IMAGE" --no-sandbox %U
Icon=saint
StartupWMClass=saint
Type=Application
Terminal=false
Categories=Development;
MimeType=x-scheme-handler/saint;
EOF
refresh_menu
if command -v xdg-mime >/dev/null 2>&1; then
  xdg-mime default saint.desktop x-scheme-handler/saint >/dev/null 2>&1 || true
fi

say "Done. Open Saint from the app menu. Updates replace $APP_IMAGE in place."
if [[ "$(realpath "$source_image")" != "$(realpath "$APP_IMAGE")" ]]; then
  say "You can delete $source_image."
fi
