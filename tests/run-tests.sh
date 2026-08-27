#!/usr/bin/env bash
# Runs every tests/test-*.sh as its own process (so one file's `set -e`
# — leaked in from sourcing install.sh — can never abort a sibling file) and
# aggregates pass/fail. Exits non-zero if any test file reports a failure.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
overall_rc=0

for f in "$SELF_DIR"/test-*.sh; do
  echo "=== $(basename "$f") ==="
  bash "$f"
  rc=$?
  if [[ "$rc" -ne 0 ]]; then
    overall_rc=1
    echo "*** $(basename "$f") FAILED (exit ${rc}) ***"
  fi
  echo ""
done

exit "$overall_rc"
