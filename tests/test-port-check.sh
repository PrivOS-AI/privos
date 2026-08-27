#!/usr/bin/env bash
# Unit tests for install.sh's port-conflict parsing/detection. Sources
# install.sh (which only defines functions — main() never runs because this
# file's $0 differs from install.sh's BASH_SOURCE[0]) and overrides
# run_ss/run_lsof/docker_port_lookup with fixture-backed stand-ins.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SELF_DIR/helpers.sh"
# shellcheck source=/dev/null
source "$SELF_DIR/../install.sh"
set +e # assertions must not abort the run; install.sh's `set -e` leaks in via source

FIXTURES="$SELF_DIR/fixtures"

# --- parse_ss_output --------------------------------------------------------

collect_listeners_from() {
  local fixture="$1"
  # shellcheck disable=SC2329 # invoked indirectly by collect_listeners() in install.sh
  run_ss() { cat "$fixture"; }
  collect_listeners
}

have_ss() { return 0; } # force the ss path regardless of what this host has installed
collect_listeners_from "$FIXTURES/ss-conflict.txt"
assert_eq "12345" "${LISTEN_PID[3000]:-}" "ss parser: port 3000 pid"
assert_eq "node" "${LISTEN_CMD[3000]:-}" "ss parser: port 3000 command"
assert_eq "6789" "${LISTEN_PID[8556]:-}" "ss parser: port 8556 pid"
assert_eq "docker-proxy" "${LISTEN_CMD[8556]:-}" "ss parser: port 8556 command"
assert_eq "" "${LISTEN_PID[9000]:-}" "ss parser: port 9000 not listening"

# --- parse_lsof_output -------------------------------------------------------

LISTEN_PID=()
LISTEN_CMD=()
parse_lsof_output < "$FIXTURES/lsof-conflict.txt"
assert_eq "12345" "${LISTEN_PID[3000]:-}" "lsof parser: port 3000 pid"
assert_eq "node" "${LISTEN_CMD[3000]:-}" "lsof parser: port 3000 command"
assert_eq "6789" "${LISTEN_PID[8556]:-}" "lsof parser: port 8556 pid"
assert_eq "docker-pr" "${LISTEN_CMD[8556]:-}" "lsof parser: port 8556 command"

# --- check_ports: conflict detected, aborts before writing anything --------

# shellcheck disable=SC2329 # invoked indirectly by check_ports()/collect_listeners() in install.sh
run_ss() { cat "$FIXTURES/ss-conflict.txt"; }
# shellcheck disable=SC2329 # invoked indirectly by check_ports() in install.sh
port_already_ours() { return 1; } # nothing is "ours" yet — fresh install
out="$(check_ports 3000 8556 8557 9000 2>&1)"
rc=$?
assert_status 1 "$rc" "check_ports: exits non-zero on conflict"
assert_contains "$out" "3000" "check_ports: conflict table lists port 3000"
assert_contains "$out" "node" "check_ports: conflict table lists owning command"
assert_contains "$out" "8556" "check_ports: conflict table lists port 8556"
assert_not_contains "$out" $'\n8557 ' "check_ports: 8557 (free) not listed as a conflict"

# --- check_ports: clean range — no conflicts --------------------------------

# shellcheck disable=SC2329 # invoked indirectly by check_ports()/collect_listeners() in install.sh
run_ss() { cat "$FIXTURES/ss-clean.txt"; }
check_ports 8557 9000 3000 8556 >/dev/null 2>&1
rc=$?
assert_status 0 "$rc" "check_ports: exits 0 when nothing requested is listening"

# --- check_ports: re-run skips ports already owned by our own containers ---

run_ss() { cat "$FIXTURES/ss-conflict.txt"; }
port_already_ours() { [[ "$1" == "3000" ]]; } # hub container from a prior install
out="$(check_ports 3000 8556 2>&1)"
rc=$?
assert_status 1 "$rc" "check_ports: still conflicts on 8556 even when 3000 is ours"
assert_not_contains "$out" $'\n3000 ' "check_ports: 3000 skipped — owned by our own hub container"
assert_contains "$out" "8556" "check_ports: 8556 still flagged (owned by something else)"

# --- expand_port_range -------------------------------------------------------

ports="$(expand_port_range "30000-30002")"
assert_eq "30000
30001
30002" "$ports" "expand_port_range: produces every port in the range"

# --- expand_port_range: L1 — span cap and strict port bounds ---------------

( expand_port_range "1-999999999" ) >/dev/null 2>&1
assert_status 1 "$?" "expand_port_range: rejects an out-of-range end port instead of hanging seq"

( expand_port_range "1-100000" ) >/dev/null 2>&1
assert_status 1 "$?" "expand_port_range: rejects a span above MAX_PORT_RANGE_SPAN"

( expand_port_range "30999-30000" ) >/dev/null 2>&1
assert_status 1 "$?" "expand_port_range: rejects start > end"

( expand_port_range "0-100" ) >/dev/null 2>&1
assert_status 1 "$?" "expand_port_range: rejects a start port of 0"

( expand_port_range "30000-30999" ) >/dev/null 2>&1
assert_status 0 "$?" "expand_port_range: accepts the real default range (span 1000)"

report_and_exit
