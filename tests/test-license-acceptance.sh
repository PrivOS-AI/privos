#!/usr/bin/env bash
# Unit tests for install.sh's license-acceptance gate: never treat silence
# as acceptance, --yes/--accept-license/PRIVOS_ACCEPT_LICENSE=1 accept
# non-interactively, an existing marker skips the prompt entirely, and the
# notice text stays accurate (never says "open source" — PCL-1.0 is not).
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SELF_DIR/helpers.sh"
# shellcheck source=/dev/null
source "$SELF_DIR/../install.sh"
set +e

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

reset_flags() {
  ASSUME_YES="false"
  ACCEPT_LICENSE_FLAG=""
  unset PRIVOS_ACCEPT_LICENSE LICENSE_ACCEPTED 2>/dev/null
}

# --- license_already_accepted: direct unit tests ---------------------------

PRIVOS_DIR="$WORK/unit"
mkdir -p "$PRIVOS_DIR"
( license_already_accepted ) >/dev/null 2>&1
assert_status 1 "$?" "license_already_accepted: false when no marker file exists"

printf 'not the right version\n' > "$PRIVOS_DIR/$LICENSE_MARKER_FILE"
( license_already_accepted ) >/dev/null 2>&1
assert_status 1 "$?" "license_already_accepted: false when marker exists but lacks PCL-1.0"

printf '%s\naccepted_at=2026-01-01T00:00:00Z\n' "$LICENSE_VERSION" > "$PRIVOS_DIR/$LICENSE_MARKER_FILE"
( license_already_accepted ) >/dev/null 2>&1
assert_status 0 "$?" "license_already_accepted: true when marker carries PCL-1.0"
rm -f "$PRIVOS_DIR/$LICENSE_MARKER_FILE"

# --- print_license_notice: content sanity -----------------------------------

notice="$(print_license_notice 2>&1)"
assert_contains "$notice" "PrivOS Community License 1.0" "print_license_notice: names the license"
assert_contains "$notice" "10" "print_license_notice: mentions the free-tier user limit"
assert_contains "$notice" "Roxane INC" "print_license_notice: names the licensor"
assert_contains "$notice" "github.com/PrivOS-AI/privos/blob/main/LICENSE" "print_license_notice: links the full text"
assert_not_contains "$notice" "open source" "print_license_notice: never says 'open source' (PCL-1.0 is not)"
assert_not_contains "$notice" "Open Source" "print_license_notice: never says 'Open Source' in any casing this test checks"

# --- require_license_acceptance: non-TTY, no flag/env -> dies, no state ----

PRIVOS_DIR="$WORK/nontty-noflag"
reset_flags
( require_license_acceptance </dev/null ) >/dev/null 2>&1
assert_status 1 "$?" "require_license_acceptance: non-TTY + no --yes/--accept-license/env dies"

TESTS_RUN=$((TESTS_RUN + 1))
if [[ ! -e "$PRIVOS_DIR" ]]; then
  echo "ok - require_license_acceptance: refuses before creating any state (no \$PRIVOS_DIR)"
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
  echo "not ok - require_license_acceptance: \$PRIVOS_DIR should not exist after a refused, pre-state gate" >&2
fi

# A bare Enter (empty answer) must be treated exactly like "no", not skipped —
# this exercises the same die path since -t 0 is false for a piped empty line too.
( require_license_acceptance <<<"" ) >/dev/null 2>&1
assert_status 1 "$?" "require_license_acceptance: an empty/blank answer is never treated as acceptance"

# --- require_license_acceptance: --yes accepts and marks LICENSE_ACCEPTED --

PRIVOS_DIR="$WORK/yes-flag"
mkdir -p "$PRIVOS_DIR"
reset_flags
# shellcheck disable=SC2034 # read by require_license_acceptance() in the sourced install.sh
ASSUME_YES="true"
require_license_acceptance </dev/null
assert_status 0 "$?" "require_license_acceptance: --yes accepts non-interactively"
assert_eq "true" "${LICENSE_ACCEPTED:-}" "require_license_acceptance: --yes sets LICENSE_ACCEPTED=true"
write_license_marker
assert_contains "$(cat "$PRIVOS_DIR/$LICENSE_MARKER_FILE" 2>/dev/null)" "$LICENSE_VERSION" \
  "write_license_marker: writes a marker containing the license version after --yes"
marker_mode="$(stat -f '%Lp' "$PRIVOS_DIR/$LICENSE_MARKER_FILE" 2>/dev/null || stat -c '%a' "$PRIVOS_DIR/$LICENSE_MARKER_FILE" 2>/dev/null)"
assert_eq "644" "$marker_mode" "write_license_marker: marker file is mode 0644"

# --- require_license_acceptance: --accept-license accepts too --------------

PRIVOS_DIR="$WORK/accept-license-flag"
mkdir -p "$PRIVOS_DIR"
reset_flags
# shellcheck disable=SC2034 # read by require_license_acceptance() in the sourced install.sh
ACCEPT_LICENSE_FLAG="true"
( require_license_acceptance </dev/null ) >/dev/null 2>&1
assert_status 0 "$?" "require_license_acceptance: --accept-license accepts non-interactively"

# --- require_license_acceptance: PRIVOS_ACCEPT_LICENSE=1 env accepts too ---

PRIVOS_DIR="$WORK/env-accept"
mkdir -p "$PRIVOS_DIR"
reset_flags
# shellcheck disable=SC2034 # read by require_license_acceptance() in the sourced install.sh
PRIVOS_ACCEPT_LICENSE="1"
( require_license_acceptance </dev/null ) >/dev/null 2>&1
assert_status 0 "$?" "require_license_acceptance: PRIVOS_ACCEPT_LICENSE=1 accepts non-interactively"
unset PRIVOS_ACCEPT_LICENSE

# --- require_license_acceptance: existing marker skips the prompt entirely -

PRIVOS_DIR="$WORK/already-accepted"
mkdir -p "$PRIVOS_DIR"
printf '%s\naccepted_at=2026-01-01T00:00:00Z\n' "$LICENSE_VERSION" > "$PRIVOS_DIR/$LICENSE_MARKER_FILE"
reset_flags
( require_license_acceptance </dev/null ) >/dev/null 2>&1
assert_status 0 "$?" "require_license_acceptance: an existing marker succeeds even non-TTY with no flags"

before_mtime="$(stat -f '%m' "$PRIVOS_DIR/$LICENSE_MARKER_FILE" 2>/dev/null || stat -c '%Y' "$PRIVOS_DIR/$LICENSE_MARKER_FILE" 2>/dev/null)"
write_license_marker
after_mtime="$(stat -f '%m' "$PRIVOS_DIR/$LICENSE_MARKER_FILE" 2>/dev/null || stat -c '%Y' "$PRIVOS_DIR/$LICENSE_MARKER_FILE" 2>/dev/null)"
assert_eq "$before_mtime" "$after_mtime" "write_license_marker: does not rewrite an already-existing accepted marker"

# --- BUNDLE_FILES / UNSIGNED_HASHED_FILES: LICENSE is on the C1 trust path -

found=0
for f in "${BUNDLE_FILES[@]}"; do [[ "$f" == "LICENSE" ]] && found=1; done
assert_eq "1" "$found" "BUNDLE_FILES: includes LICENSE"

found=0
for f in "${UNSIGNED_HASHED_FILES[@]}"; do [[ "$f" == "LICENSE" ]] && found=1; done
assert_eq "1" "$found" "UNSIGNED_HASHED_FILES: LICENSE is sha256-verified via versions.json (C1 path)"

report_and_exit
