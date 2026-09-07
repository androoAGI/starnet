#!/usr/bin/env bash
# Installed Intel macOS acceptance: exercise the same Finder/LaunchServices path a user takes,
# then prove a v0.9.0 manual-sidecar station is recovered into the desktop shelf and survives restart.
set -euo pipefail

dmg=${1:?usage: verify-macos-intel-installed.sh <StarNet_x64.dmg> [receipt.json]}
receipt=${2:-intel-macos-installed-acceptance.json}
require_notarized=${STARNET_REQUIRE_NOTARIZED:-true}
fixture_root=${STARNET_V090_FIXTURE_ROOT:-test/fixtures/upgrade/v090-intel-mac}

fail() {
  echo "::error::$*"
  exit 1
}

[ "$(uname -m)" = "x86_64" ] || fail "installed Intel acceptance requires an x86_64 Mac, got $(uname -m)"
[ -f "$dmg" ] || fail "Intel DMG does not exist: $dmg"
[ -f "$fixture_root/agent.save.json" ] || fail "v0.9.0 save fixture is missing"
[ -f "$fixture_root/recovery-canary.txt" ] || fail "v0.9.0 recovery canary is missing"

legacy="$HOME/.local/share/StarNet/workspaces"
desktop="$HOME/Library/Application Support/ai.skynet.harness/workspaces"
app_data="$HOME/Library/Application Support/ai.skynet.harness"
startup_log="$app_data/startup.log"
installed="/Applications/StarNet.app"
mount_point="$RUNNER_TEMP/starnet-intel-dmg"
trust_log="$RUNNER_TEMP/starnet-intel-spctl.txt"
source_hash_before=""
source_hash_after=""
launch_port=""

for target in "$legacy" "$desktop" "$installed"; do
  [ ! -e "$target" ] || fail "clean Intel runner invariant failed; target already exists: $target"
done

mkdir -p "$legacy" "$mount_point"
cp "$fixture_root/agent.save.json" "$legacy/agent.save.json"
cp "$fixture_root/recovery-canary.txt" "$legacy/recovery-canary.txt"
source_hash_before=$(shasum -a 256 "$legacy/agent.save.json" | awk '{print $1}')

mounted=false
cleanup() {
  if pgrep -f "$installed/Contents/MacOS/skynet-desktop" >/dev/null 2>&1; then
    osascript -e 'tell application "StarNet" to quit' >/dev/null 2>&1 || true
    sleep 2
  fi
  if [ "$mounted" = true ]; then hdiutil detach "$mount_point" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

hdiutil attach "$dmg" -mountpoint "$mount_point" -nobrowse -readonly >/dev/null
mounted=true
source_app=$(find "$mount_point" -maxdepth 2 -type d -name 'StarNet.app' -print -quit)
[ -n "${source_app:-}" ] || fail "Intel DMG contains no StarNet.app"

sudo ditto "$source_app" "$installed"
exe="$installed/Contents/MacOS/skynet-desktop"
[ -x "$exe" ] || fail "installed StarNet executable is missing"
file "$exe" | grep -q 'x86_64' || fail "installed executable is not x86_64"
codesign --verify --deep --strict --verbose=2 "$installed"

spctl -a -t exec -vv "$installed" >"$trust_log" 2>&1 || true
cat "$trust_log"
if [ "$require_notarized" = "true" ]; then
  grep -qi 'accepted' "$trust_log" || fail "Gatekeeper did not accept the installed Intel app"
  grep -qi 'source=Notarized Developer ID' "$trust_log" || fail "installed Intel app is not a notarized Developer ID build"
fi

launch_with_finder() {
  local before_lines candidate_port
  before_lines=0
  if [ -f "$startup_log" ]; then before_lines=$(wc -l < "$startup_log"); fi
  osascript - "$installed" <<'APPLESCRIPT'
on run argv
  set app_file to POSIX file (item 1 of argv)
  tell application "Finder" to open app_file
end run
APPLESCRIPT

  launch_port=""
  for _ in $(seq 1 240); do
    if [ -f "$startup_log" ]; then
      while IFS= read -r candidate_port; do
        if [ -n "$candidate_port" ] && curl -fsS "http://127.0.0.1:$candidate_port/api/health" >/dev/null; then
          launch_port=$candidate_port
          pgrep -f "$exe" >/dev/null || fail "Finder returned but the Intel desktop process is not alive"
          return 0
        fi
      done < <(tail -n "+$((before_lines + 1))" "$startup_log" \
        | sed -n 's/.*spawn_sidecar pid=[0-9][0-9]* port=\([0-9][0-9]*\) listening=true.*/\1/p')
    fi
    sleep 0.25
  done
  [ ! -f "$startup_log" ] || tail -n 80 "$startup_log"
  fail "Finder-launched Intel app did not expose a listening sidecar within 60 seconds"
}

quit_cleanly() {
  osascript -e 'tell application "StarNet" to quit'
  for _ in $(seq 1 80); do
    if ! pgrep -f "$exe" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  fail "StarNet did not exit after the normal application Quit event"
}

launch_with_finder

[ -f "$desktop/agent.save.json" ] || fail "desktop shelf did not receive the v0.9.0 station save"
[ -f "$desktop/.migrated" ] || fail "desktop shelf has no completed migration marker"
[ -f "$desktop/.migration-receipt.json" ] || fail "desktop shelf has no validated migration receipt"
cmp "$legacy/recovery-canary.txt" "$desktop/recovery-canary.txt" || fail "full workspace canary did not survive migration"

python3 - "$desktop/agent.save.json" "$desktop/.migration-receipt.json" "$legacy" <<'PY'
import json, os, sys
save_path, receipt_path, legacy = sys.argv[1:]
with open(save_path, encoding="utf-8") as handle:
    envelope = json.load(handle)
doc = envelope.get("doc", envelope)
assert doc.get("schema") == "starnet.save", doc.get("schema")
assert doc.get("version") == 6, doc.get("version")
assert doc.get("agent", {}).get("name") == "NOVA-090-INTEL"
assert doc.get("workstreams", [{}])[0].get("history", [{}])[0].get("content") == "preserve this v0.9.0 conversation"
assert doc.get("release090UnknownUserField") == {"nested": ["must", "survive"]}
with open(receipt_path, encoding="utf-8") as handle:
    receipt = json.load(handle)
assert receipt.get("validated") is True
roots = [os.path.realpath(value) for value in receipt.get("sourceRoots", receipt.get("source_roots", []))]
assert os.path.realpath(legacy) in roots, roots
PY

grep -F 'migrated_from=' "$startup_log" | tail -1 | grep -F "$legacy" >/dev/null \
  || fail "desktop startup log does not identify the v0.9.0 manual-sidecar source"
source_hash_after=$(shasum -a 256 "$legacy/agent.save.json" | awk '{print $1}')
[ "$source_hash_after" = "$source_hash_before" ] || fail "v0.9.0 source save changed during recovery"

quit_cleanly
launch_with_finder

python3 - "$desktop/agent.save.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    envelope = json.load(handle)
doc = envelope.get("doc", envelope)
assert doc.get("agent", {}).get("name") == "NOVA-090-INTEL"
assert doc.get("release090UnknownUserField") == {"nested": ["must", "survive"]}
PY

source_hash_after=$(shasum -a 256 "$legacy/agent.save.json" | awk '{print $1}')
[ "$source_hash_after" = "$source_hash_before" ] || fail "v0.9.0 source save changed after desktop restart"
quit_cleanly

python3 - "$receipt" "$dmg" "$installed" "$launch_port" "$source_hash_before" "$require_notarized" <<'PY'
import datetime, hashlib, json, os, platform, plistlib, sys
receipt, dmg, installed, port, source_hash, required = sys.argv[1:]
with open(os.path.join(installed, "Contents", "Info.plist"), "rb") as handle:
    version = plistlib.load(handle)["CFBundleShortVersionString"]
assert isinstance(version, str) and version, "installed bundle version missing"
if os.environ.get("STARNET_EXPECTED_VERSION"):
    assert version == os.environ["STARNET_EXPECTED_VERSION"], "wrong installed version"
with open(dmg, "rb") as handle:
    digest = hashlib.sha256(handle.read()).hexdigest()
value = {
    "schema": "starnet.intel-macos-installed-acceptance.v1",
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "machine": {"architecture": platform.machine(), "runner": "macos-15-intel"},
    "artifact": {"path": os.path.basename(dmg), "sha256": digest, "notarizedRequired": required == "true"},
    "install": {"path": installed, "version": version, "finderLaunch": True, "sidecarListening": True, "portObserved": bool(port)},
    "upgrade": {"from": "0.9.0", "to": version, "sourcePreservedSha256": source_hash, "restartSurvived": True}
}
with open(receipt, "w", encoding="utf-8") as handle:
    json.dump(value, handle, indent=2)
    handle.write("\n")
print(json.dumps(value, indent=2))
PY

echo "::notice::Intel macOS installed acceptance GREEN - Finder launch, v0.9.0 split-workspace recovery, source preservation, and restart all proved"
