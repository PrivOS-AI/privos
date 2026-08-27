#!/usr/bin/env bash
# Minimal TAP-ish assertion helpers shared by tests/test-*.sh. Sourced, not
# executed. Every assert increments TESTS_RUN and, on failure, TESTS_FAILED
# and prints a "not ok" line — callers keep running remaining assertions
# instead of aborting at the first failure (each test-*.sh disables `set -e`
# after sourcing install.sh for exactly this reason).

TESTS_RUN=0
TESTS_FAILED=0

assert_eq() {
  local expected="$1" actual="$2" msg="${3:-values equal}"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$expected" == "$actual" ]]; then
    echo "ok - ${msg}"
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    echo "not ok - ${msg} (expected [${expected}] got [${actual}])" >&2
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="${3:-contains}"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "ok - ${msg}"
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    echo "not ok - ${msg} (expected to find [${needle}])" >&2
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" msg="${3:-does not contain}"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "ok - ${msg}"
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    echo "not ok - ${msg} (did not expect to find [${needle}])" >&2
  fi
}

# assert_status <expected-exit-code> <actual-exit-code> <msg>
assert_status() {
  local expected="$1" actual="$2" msg="${3:-exit status}"
  assert_eq "$expected" "$actual" "$msg"
}

report_and_exit() {
  echo ""
  echo "# ${TESTS_RUN} run, $(( TESTS_RUN - TESTS_FAILED )) passed, ${TESTS_FAILED} failed — $(basename "$0")"
  [[ "$TESTS_FAILED" -eq 0 ]]
}
