#!/usr/bin/env bash
# Installed integrity for the Intel installed acceptance (scripts/verify-macos-intel-installed.sh), on the notarized
# bytes it has just installed and Finder-launched. Two claims, one subcommand each:
#
#   page-boot <startup.log> <from-line> <wait-seconds>
#     The station page's own boot verdict. bootguard sends starnet_boot_report once per page load and the shell writes
#     one "page-boot:" line to startup.log (src-tauri/src/boot_report.rs). Every such line after line <from-line> must
#     read "passed · N of N station scripts ran · 0 not run", and at least one must arrive within <wait-seconds>
#     (gh#136: a script that threw while loading left a station whose boot check still said passed). Prints the lines
#     it judged.
#
#   install <installed StarNet.app> <its executable> <work-dir>
#     The executable's own headless verify (--starnet-verify-install, src-tauri/src/install_manifest.rs) over the install
#     manifest embedded in it must exit 0 and read "install: verified N files" with N >= MIN_MANIFEST_FILES, after the
#     app's real launches: nothing the running app did rewrote a listed file. Then MODULE zeroed in a COPY of the app
#     (85f602c4 / E62) must be named, alone and as empty, by the copy's own verify, which exits 3. A copy, because
#     truncating a file inside the installed app would break its notarized seal; the installed MODULE is proven still
#     whole afterwards. The receipts (--out) and the printed lines stay in <work-dir>: install-verify.json/.txt and
#     zeroed-verify.json/.txt.
#
# A failed claim prints ::error:: and exits 1. bash 3.2 and builtins wherever possible, no python or jq:
# test/release-train-macos-trust.test.js runs every claim against a stub executable.
set -euo pipefail
export LC_ALL=C

# Under the ~890 code files of the repo's own sidecar, shared, bin and frontend trees (the staged voice deps add ~1,500
# more), and far over any manifest built over stub or missing trees. The Windows published-upgrade proof
# (scripts/ci/windows-published-upgrade-proof.ps1, Assert-InstalledIntegrity) holds the same floor and module.
MIN_MANIFEST_FILES=600
MODULE=sidecar/tools/builtin/shell.js
VERIFY_SECONDS=180
usage="usage: verify-macos-installed-integrity.sh page-boot <startup.log> <from-line> <wait-seconds> | install <StarNet.app> <executable> <work-dir>"

fail() {
  echo "::error::$*"
  exit 1
}

whole_number() {
  case "$1" in
    '' | *[!0-9]*) fail "$2 is not a whole number: '$1'. $usage" ;;
  esac
}

page_boot() {
  local log=$1 from=${2//[[:space:]]/} wait=$3 polls=0 n line judged
  local passed='^page-boot: passed · ([0-9]+) of ([0-9]+) station scripts ran · 0 not run$'
  whole_number "$from" '<from-line>'
  whole_number "$wait" '<wait-seconds>'
  while :; do
    judged=0
    n=0
    if [ -f "$log" ]; then
      # Complete lines only: a line still being written has no newline yet, and the next poll reads it whole.
      while IFS= read -r line; do
        n=$((n + 1))
        [ "$n" -gt "$from" ] || continue
        case "$line" in
          'page-boot: '*) ;;
          *) continue ;;
        esac
        if [[ $line =~ $passed ]] && [ "${BASH_REMATCH[1]}" = "${BASH_REMATCH[2]}" ] && [ "${BASH_REMATCH[2]}" -gt 0 ]; then
          echo "$line"
          judged=$((judged + 1))
        else
          fail "the installed station page did not boot whole (startup.log line $n): $line"
        fi
      done < "$log"
    fi
    [ "$judged" -eq 0 ] || return 0
    if [ "$polls" -ge $((wait * 5)) ]; then
      fail "no page-boot line reached $log within ${wait}s after its line $from: the station page never reported its boot (bootguard sends starnet_boot_report once per page load)"
    fi
    sleep 0.2
    polls=$((polls + 1))
  done
}

# <executable> <receipt path without extension> <label>: runs the headless verify within VERIFY_SECONDS and sets
# status, summary (the "install:" line), named (the last named file line) and named_count.
headless_verify() {
  local exe=$1 base=$2 label=$3 line
  # emptied, not removed: a receipt left by an earlier run can never pass for this one's
  : > "$base.json"
  # the exit status arrives on fd 3 when the verify ends; read -t bounds the wait without polling
  exec 3< <(
    set +e
    "$exe" --starnet-verify-install --out "$base.json" > "$base.txt" 2>&1
    echo "$?"
  )
  status=""
  read -r -t "$VERIFY_SECONDS" -u 3 status || true
  exec 3<&-
  case "$status" in
    '' | *[!0-9]*) fail "[$label] $exe --starnet-verify-install did not exit within ${VERIFY_SECONDS}s" ;;
  esac
  summary=""
  named=""
  named_count=0
  while IFS= read -r line || [ -n "$line" ]; do
    echo "  [$label] $line"
    case "$line" in
      'install: '*) [ -n "$summary" ] || summary=$line ;;
      '  '?*)
        named=${line#  }
        named_count=$((named_count + 1))
        ;;
    esac
  done < "$base.txt"
  [ -s "$base.json" ] ||
    fail "[$label] $exe wrote no install-verify receipt (exit $status): an executable built before the install manifest has no --starnet-verify-install"
}

install_claims() {
  local app=${1%/} exe=$2 work=$3 rel copy copy_exe installed_module copied_module files
  local verified='^install: verified ([0-9][0-9,]*) files$'
  [ -d "$app" ] || fail "the installed app does not exist: $app"
  [ -n "$work" ] || fail "no work directory. $usage"
  case "$exe" in
    "$app"/*) rel=${exe#"$app"/} ;;
    *) fail "the executable $exe is not inside $app" ;;
  esac
  [ -f "$exe" ] && [ -x "$exe" ] || fail "the installed executable is missing: $exe"
  # Where the executable finds its resources on macOS (install_manifest.rs root_candidates: <exe dir>/../Resources).
  installed_module="${exe%/*}/../Resources/$MODULE"
  [ -s "$installed_module" ] || fail "the installed app has no non-empty $MODULE: $installed_module"
  rm -rf "$work/zeroed-copy"
  mkdir -p "$work/zeroed-copy"

  # (1) The installed app, after its real launches: every listed file at its shipped size and sha256.
  headless_verify "$exe" "$work/install-verify" installed
  if [ "$status" -ne 0 ] || ! [[ $summary =~ $verified ]]; then
    fail "the installed app's headless install verify exited $status and reads '${summary:-no install: line}', not verified"
  fi
  files=${BASH_REMATCH[1]//,/}
  [ "$files" -ge "$MIN_MANIFEST_FILES" ] ||
    fail "the installed app verified only $files files: its install manifest misses resource trees (one over the real trees lists at least $MIN_MANIFEST_FILES)"
  echo "::notice::installed app: ${summary#install: } of the install manifest embedded in it, after its Finder launches"

  # (2) A zeroed module, in a copy of the app: the copy's own executable must find the copy's resources and name it.
  copy="$work/zeroed-copy/${app##*/}"
  ditto "$app" "$copy"
  copy_exe="$copy/$rel"
  copied_module="${copy_exe%/*}/../Resources/$MODULE"
  [ -s "$copied_module" ] || fail "the copy of the app has no non-empty $MODULE to zero"
  [ -w "$copied_module" ] || chmod u+w "$copied_module"
  : > "$copied_module"
  headless_verify "$copy_exe" "$work/zeroed-verify" "zeroed copy"
  rm -rf "$work/zeroed-copy"
  [ "$status" -eq 3 ] ||
    fail "a copy of the app with an empty $MODULE: its headless verify exited $status ('${summary:-no install: line}'), not 3 (damaged)"
  case "$summary" in
    "install: DAMAGED - 1 of "[0-9]*" files: $MODULE is empty (0 of "[1-9]*" bytes)") ;;
    *) fail "a copy of the app with an empty $MODULE: its headless verify reads '${summary:-no install: line}', not that one file empty" ;;
  esac
  if [ "$named_count" -ne 1 ] || [ "${named%% is empty (0 of *}" != "$MODULE" ]; then
    fail "a copy of the app with an empty $MODULE: its headless verify named $named_count file(s) ('$named'), not exactly $MODULE"
  fi
  [ -s "$installed_module" ] || fail "the installed $MODULE was emptied: the zeroed-module proof must touch only its copy"
  echo "::notice::a copy of the app with an empty $MODULE: its headless verify exits 3 naming it ($named)"
}

case "${1:-}" in
  page-boot)
    [ "$#" -eq 4 ] || fail "$usage"
    page_boot "$2" "$3" "$4"
    ;;
  install)
    [ "$#" -eq 4 ] || fail "$usage"
    install_claims "$2" "$3" "$4"
    ;;
  *) fail "$usage" ;;
esac
