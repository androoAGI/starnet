#!/usr/bin/env bash
# Resume an existing Apple notarization submission, tolerate transient runner
# network failures, staple the accepted ticket, and prove Gatekeeper's verdict for both
# the DMG itself and the app inside it.
set -euo pipefail

submission_json=${1:?usage: notarize-macos-finalize.sh <submission-json> <dmg>}
dmg=${2:?usage: notarize-macos-finalize.sh <submission-json> <dmg>}
poll_seconds=${NOTARIZATION_POLL_SECONDS:-120}
poll_minutes=${NOTARIZATION_POLL_MINUTES:-330}

for name in APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  if [ -z "${!name:-}" ]; then
    echo "::error::notarization finalization is missing $name"
    exit 1
  fi
done
if [ ! -f "$submission_json" ] || [ ! -f "$dmg" ]; then
  echo "::error::notarization input is incomplete: json=$submission_json dmg=$dmg"
  exit 1
fi

submission_id=$(jq -er '.id' "$submission_json")
deadline=$((SECONDS + poll_minutes * 60))
info_json="$RUNNER_TEMP/notary-info-$submission_id.json"
log_json="$RUNNER_TEMP/notary-log-$submission_id.json"

while [ "$SECONDS" -lt "$deadline" ]; do
  if xcrun notarytool info "$submission_id" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --output-format json > "$info_json"; then
    status=$(jq -r '.status // "Unknown"' "$info_json")
    echo "::notice::Apple notarization $submission_id status: $status"
    case "$status" in
      Accepted)
        xcrun notarytool log "$submission_id" \
          --apple-id "$APPLE_ID" \
          --password "$APPLE_PASSWORD" \
          --team-id "$APPLE_TEAM_ID" \
          "$log_json" || true
        if [ -f "$log_json" ]; then
          jq '{status, statusSummary, issues}' "$log_json" || cat "$log_json"
        fi
        xcrun stapler staple "$dmg"
        xcrun stapler validate "$dmg"
        break
        ;;
      Invalid|Rejected)
        xcrun notarytool log "$submission_id" \
          --apple-id "$APPLE_ID" \
          --password "$APPLE_PASSWORD" \
          --team-id "$APPLE_TEAM_ID" \
          "$log_json" || true
        [ ! -f "$log_json" ] || cat "$log_json"
        echo "::error::Apple rejected notarization submission $submission_id"
        exit 1
        ;;
    esac
  else
    echo "::warning::temporary failure polling Apple submission $submission_id; retrying in ${poll_seconds}s"
  fi
  sleep "$poll_seconds"
done

if ! xcrun stapler validate "$dmg" >/dev/null 2>&1; then
  echo "::error::Apple submission $submission_id is still processing after ${poll_minutes}m. Rerun only this failed finalization job; do not rebuild or resubmit."
  exit 75
fi

# A user's Mac assesses the disk image before it mounts anything, so the DMG's own
# signature, ticket and Gatekeeper verdict are proven first, then the app inside it.
bash "$(dirname "$0")/verify-macos-dmg.sh" notarized "$dmg" "$APPLE_TEAM_ID"
dmg_sha=$(shasum -a 256 "$dmg" | awk '{print $1}')

mount_point=""
cleanup_mount() {
  if [ -n "$mount_point" ]; then hdiutil detach "$mount_point" >/dev/null 2>&1 || true; fi
}
trap cleanup_mount EXIT
mount_point=$(hdiutil attach "$dmg" -nobrowse -readonly | sed -n 's|^.*\(/Volumes/.*\)$|\1|p' | tail -1)
app=$(find "$mount_point" -maxdepth 2 -type d -name '*.app' -print -quit)
if [ -z "${app:-}" ]; then
  echo "::error::stapled DMG contains no app bundle"
  exit 1
fi

spctl_output="$RUNNER_TEMP/spctl-notarized.txt"
spctl -a -t exec -vv "$app" > "$spctl_output" 2>&1 || true
cat "$spctl_output"
if ! grep -qi 'accepted' "$spctl_output" || ! grep -qi 'source=Notarized Developer ID' "$spctl_output"; then
  echo "::error::Gatekeeper did not return the notarized Developer ID verdict for $app"
  exit 1
fi

# The bytes uploaded next must be the bytes whose signature was just verified.
hdiutil detach "$mount_point" >/dev/null || hdiutil detach -force "$mount_point" >/dev/null
mount_point=""
if [ "$(shasum -a 256 "$dmg" | awk '{print $1}')" != "$dmg_sha" ]; then
  echo "::error::the DMG changed after its signature was verified; refusing to hand those bytes to the release"
  exit 1
fi
echo "::notice::DMG stapled; Gatekeeper accepts the DMG and its app as source=Notarized Developer ID (sha256 $dmg_sha)"
