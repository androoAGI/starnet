#!/usr/bin/env bash
# Prove a release DMG's OWN signature, not only the app inside it. Gatekeeper assesses
# the disk image before anything is mounted: a DMG whose embedded signature does not
# match its bytes is refused on the user's Mac ("invalid signature (code or signature
# have been modified)" / "internal error in Code Signing subsystem") even when the app
# inside is notarized. That is the StarNet_0.13.5_aarch64.dmg field report; the train
# had only ever checked the .app.
#   signed     before Apple submission: a valid, strict Developer ID signature.
#   notarized  the shipped bytes: the above, a valid stapled ticket, and Gatekeeper's
#              primary-signature verdict for an opened disk image.
set -euo pipefail

usage="usage: verify-macos-dmg.sh <signed|notarized> <dmg> [expected-team-id]"
mode=${1:?$usage}
dmg=${2:?$usage}
expected_team=$(printf '%s' "${3:-}" | tr -d '[:space:]')
case "$mode" in
  signed|notarized) ;;
  *) echo "::error::unknown DMG proof mode '$mode' — $usage"; exit 1 ;;
esac
if [ ! -f "$dmg" ]; then
  echo "::error::DMG to verify does not exist: $dmg"
  exit 1
fi

name=$(basename "$dmg")
out=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/dmg-proof.XXXXXX")

fail() {
  echo "::error::[$name] $1"
  codesign -dvvv "$dmg" 2>&1 | sed -n '1,30p' || true
  exit 1
}

# (1) the image's embedded signature must match its bytes (no modification after signing).
if ! codesign --verify --strict --verbose=2 "$dmg" > "$out/verify.txt" 2>&1; then
  cat "$out/verify.txt"
  fail "codesign --verify --strict rejects the DMG's own signature."
fi
cat "$out/verify.txt"

# (2) signed by the release's Developer ID identity, never ad-hoc or another team.
codesign -dvvv "$dmg" > "$out/cs.txt" 2>&1 || true
grep -q '^Authority=Developer ID Application' "$out/cs.txt" ||
  fail "DMG is not signed by a Developer ID Application identity."
team=$(sed -n 's/^TeamIdentifier=//p' "$out/cs.txt" | head -1)
if [ -n "$expected_team" ] && [ "$team" != "$expected_team" ]; then
  fail "DMG TeamIdentifier '$team' is not the release team '$expected_team'."
fi
grep -q '^Timestamp=' "$out/cs.txt" ||
  echo "::warning::[$name] DMG signature carries no secure timestamp."

if [ "$mode" = notarized ]; then
  # (3) the ticket Apple issued for this exact image is stapled to it.
  if ! xcrun stapler validate "$dmg" > "$out/stapler.txt" 2>&1; then
    cat "$out/stapler.txt"
    fail "xcrun stapler validate finds no valid stapled notarization ticket."
  fi
  cat "$out/stapler.txt"

  # (4) Gatekeeper's verdict for opening the image, the check a user's Mac makes first.
  spctl_status=0
  spctl -a -t open --context context:primary-signature -vv "$dmg" > "$out/spctl.txt" 2>&1 || spctl_status=$?
  cat "$out/spctl.txt"
  if [ "$spctl_status" -ne 0 ] || ! grep -q ': accepted' "$out/spctl.txt" ||
      ! grep -q 'source=Notarized Developer ID' "$out/spctl.txt"; then
    fail "Gatekeeper does not accept the DMG as a Notarized Developer ID disk image (spctl exit $spctl_status)."
  fi
fi

sha=$(shasum -a 256 "$dmg" | awk '{print $1}')
echo "::notice::[$name] DMG $mode proof passed: team ${team:-?}, sha256 $sha"
