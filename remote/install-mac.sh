#!/bin/bash
set -euo pipefail
umask 077
# Build the standard StarNet desktop with local and remote modes in one app.
source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ $(uname -s) == Darwin ]] || { echo 'This installer is for macOS' >&2; exit 1; }
app_target=${1:-/Applications/StarNet.app}
cd "$source_root"
node scripts/prepare-node.mjs
node scripts/prepare-remote-desktop.mjs
node scripts/stage-voice-deps.mjs
node scripts/stage-frontend-dist.mjs
node_modules/.bin/tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false,"macOS":{"signingIdentity":"-"}}}' --ci
app_build="$source_root/src-tauri/target/release/bundle/macos/StarNet.app"
git rev-parse HEAD > "$app_build/Contents/Resources/SOURCE_REVISION"
codesign --force --sign - "$app_build/Contents/Resources/bin/gh"
codesign --force --sign - --entitlements "$source_root/src-tauri/entitlements.plist" "$app_build"
codesign --verify --deep --strict "$app_build"
backup_root="$source_root/work/mac-build/replaced-apps"
mkdir -p "$backup_root"
# Quit through the original save/lifecycle handler before replacing the bundle.
if pgrep -x skynet-desktop >/dev/null 2>&1; then
  osascript -e 'tell application "StarNet" to quit' >/dev/null 2>&1 || true
fi
for attempt in {1..30}; do
  if ! pgrep -x skynet-desktop >/dev/null 2>&1; then break; fi
  sleep 1
done
if pgrep -x skynet-desktop >/dev/null 2>&1; then
  echo 'StarNet is still closing. Quit it normally, then run the installer again. The built app is ready.' >&2
  exit 1
fi
client_backup="$source_root/work/mac-build/client-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$client_backup"
for previous in "$HOME/.config/starnet-remote" "$HOME/Library/WebKit/ai.skynet.harness"; do
  [[ -e "$previous" ]] || continue
  ditto "$previous" "$client_backup/$(basename "$previous")"
done
for previous in "$app_target"; do
  [[ -e "$previous" ]] || continue
  mv "$previous" "$backup_root/$(basename "$previous" .app) $(date +%Y%m%d-%H%M%S).app"
done
ditto "$app_build" "$app_target"
echo "Installed $app_target with local and remote modes. Previous apps and station data are retained."
