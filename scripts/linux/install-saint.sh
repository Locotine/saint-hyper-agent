#!/usr/bin/env bash
# FILE: install-saint.sh
# Purpose: Installs a Saint AppImage as a desktop app on Ubuntu/Debian: a fixed
#          ~/Applications/saint.AppImage that the in-app updater overwrites, plus the
#          menu entry and icon. Shipped with every GitHub release.
# Usage: bash install-saint.sh [path/to/Saint-*.AppImage]   (default: newest in ~/Downloads)
#        bash install-saint.sh --uninstall                 (data in ~/.saint stays)

set -euo pipefail

APP_DIR="$HOME/Applications"
APP_IMAGE="$APP_DIR/saint.AppImage"
XDG_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
DESKTOP_DIR="$XDG_DATA_DIR/applications"
DESKTOP_FILE="$DESKTOP_DIR/saint.desktop"
ICON_THEME_DIR="$XDG_DATA_DIR/icons/hicolor"
ICON_DIR="$ICON_THEME_DIR/256x256/apps"
LEGACY_ICON_FILE="$ICON_THEME_DIR/1024x1024/apps/saint.png"

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }
fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }
confirm() {
  local reply
  read -r -p "$1 [y/N] " reply </dev/tty 2>/dev/null || return 1
  [[ "$reply" =~ ^[Yy]$ ]]
}
run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    local cmd
    printf -v cmd '%q ' "$@"
    su -c "$cmd"
  fi
}
refresh_menu() {
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1 && [[ -d "$ICON_THEME_DIR" ]]; then
    gtk-update-icon-cache -f -t "$ICON_THEME_DIR" >/dev/null 2>&1 || true
  fi
}

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$APP_IMAGE" "$DESKTOP_FILE" "$ICON_DIR/saint-desktop.png" "$ICON_DIR/saint.png" "$LEGACY_ICON_FILE"
  refresh_menu
  say "Removed Saint Hyper Agent. Your data in ~/.saint is kept."
  exit 0
fi

[[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]] || fail "This build is for Linux x86_64."

source_image="${1:-}"
if [[ -z "$source_image" ]]; then
  # Saint-Hyper-Agent_<version>_amd64.AppImage (Tauri), Saint_<version>_amd64.AppImage
  # (Tauri before the rename) or Saint-<version>-x86_64.AppImage (Electron);
  # Saint-Beta-* is a different app.
  source_image="$(ls -t "$HOME"/Downloads/Saint-Hyper-Agent_[0-9]*.AppImage \
    "$HOME"/Downloads/Saint_[0-9]*.AppImage "$HOME"/Downloads/Saint-[0-9]*.AppImage 2>/dev/null \
    | head -n 1 || true)"
  [[ -n "$source_image" ]] || fail "No Saint-Hyper-Agent_<version>_amd64.AppImage in ~/Downloads. Pass its path."
fi
[[ -f "$source_image" ]] || fail "$source_image does not exist."

if pgrep -x saint-desktop >/dev/null 2>&1 || pgrep -x saint >/dev/null 2>&1; then
  fail "Saint Hyper Agent is running. Quit it, then run this again."
fi

# AppImages mount themselves through FUSE 2, which Ubuntu 22.04+ and Debian 12/13
# do not always install by default. Debian omits /sbin and /usr/sbin from user PATH,
# so resolve ldconfig explicitly there too.
if ! PATH="$PATH:/sbin:/usr/sbin" ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
  fuse_package=libfuse2
  if apt-cache show libfuse2t64 >/dev/null 2>&1; then fuse_package=libfuse2t64; fi
  say "AppImages need $fuse_package."
  if confirm "Install $fuse_package with apt now?"; then
    run_as_root apt-get install -y "$fuse_package"
  else
    fail "Install it with: sudo apt install $fuse_package"
  fi
fi

# A .deb install alongside the AppImage would show a second menu entry and both
# would update separately; keep one. Match Saint's own packages without touching
# Debian's unrelated `saint` 2.5.0 bioinformatics package (`saint << 2` only).
if command -v dpkg-query >/dev/null 2>&1; then
  deb_packages=""
  while read -r pkg ver status; do
    [[ "$status" == "install ok installed" ]] || continue
    lower_pkg="$(printf '%s' "$pkg" | tr '[:upper:]' '[:lower:]')"
    if [[ "$lower_pkg" == "saint-hyper-agent" || "$lower_pkg" == "saint-beta" || "$lower_pkg" =~ ^synara([-_.]|$) ]]; then
      deb_packages="${deb_packages:+$deb_packages }$pkg"
    elif [[ "$lower_pkg" == "saint" ]] && dpkg --compare-versions "$ver" lt 2 2>/dev/null; then
      deb_packages="${deb_packages:+$deb_packages }$pkg"
    fi
  done < <(dpkg-query -W -f='${Package} ${Version} ${Status}\n' 2>/dev/null || true)
  if [[ -n "$deb_packages" ]]; then
    say "Found installed .deb package(s): $deb_packages"
    if confirm "Remove them with apt (your data in ~/.saint and ~/.saint-beta stays)?"; then
      # shellcheck disable=SC2086
      run_as_root apt-get remove -y $deb_packages
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
icon_extracted=false
for candidate in \
  "usr/share/icons/hicolor/256x256/apps/saint-desktop.png" \
  "usr/share/icons/hicolor/512x512/apps/saint-desktop.png" \
  "usr/share/icons/hicolor/128x128/apps/saint-desktop.png" \
  "usr/share/icons/hicolor/1024x1024/apps/saint-desktop.png" \
  "usr/share/icons/hicolor/256x256/apps/saint.png" \
  "usr/share/icons/hicolor/1024x1024/apps/saint.png"; do
  (cd "$extract_dir" && "$APP_IMAGE" --appimage-extract "$candidate" >/dev/null 2>&1) || true
  if [[ -f "$extract_dir/squashfs-root/$candidate" ]]; then
    cp "$extract_dir/squashfs-root/$candidate" "$ICON_DIR/saint-desktop.png"
    rm -f "$LEGACY_ICON_FILE"
    icon_extracted=true
    break
  fi
done
if [[ "$icon_extracted" != true ]]; then
  say "Could not extract the icon; the menu entry uses a generic one."
fi

# Tauri/WebKitGTK AppImages ship usr/bin/saint-desktop and do not take Electron's
# `--no-sandbox` flag; keep `--no-sandbox` only for legacy Electron AppImages.
exec_line="\"$APP_IMAGE\""
(cd "$extract_dir" && "$APP_IMAGE" --appimage-extract "usr/bin/saint-desktop" >/dev/null 2>&1) || true
if [[ ! -e "$extract_dir/squashfs-root/usr/bin/saint-desktop" ]]; then
  exec_line="\"$APP_IMAGE\" --no-sandbox"
fi

cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Name=Saint Hyper Agent
Comment=Saint desktop build
Exec=$exec_line
Icon=saint-desktop
StartupWMClass=saint
Type=Application
Terminal=false
Categories=Development;
EOF
refresh_menu

say "Done. Open Saint Hyper Agent from the app menu. Updates replace $APP_IMAGE in place."
if [[ "$(realpath "$source_image")" != "$(realpath -m "$APP_IMAGE")" ]]; then
  say "You can delete $source_image."
fi
