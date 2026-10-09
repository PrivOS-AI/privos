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

# shellcheck disable=SC2329 # invoked indirectly via the sourced install.sh
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

# --- port_already_ours: recognizes every container it can move a port for ---
# Regression: port_already_ours previously omitted "publisher" from its
# container list, so re-running install.sh (plain or --upgrade) on an already
# running stack always reported the publisher's own bound port (8558 by
# default) as a foreign conflict and aborted, even though nothing but our own
# prior install owned it. Runs before any test below overrides
# port_already_ours() itself, so this exercises the REAL function sourced
# from install.sh. PROJECT_NAME is already "privos" (install.sh's own
# default, unchanged by sourcing) so container_name lookups below resolve to
# "privos-<service>" without needing to set it here.

# shellcheck disable=SC2329 # invoked indirectly by port_already_ours()
docker_port_lookup() {
	case "$1" in
	privos-publisher) echo '{"8558/tcp":[{"HostIp":"127.0.0.1","HostPort":"8558"}]}' ;;
	privos-hub) echo '{"3000/tcp":[{"HostIp":"0.0.0.0","HostPort":"3000"}]}' ;;
	*) echo "" ;;
	esac
}
# shellcheck disable=SC2218 # sourced from install.sh; this file redefines it locally further below for other cases
port_already_ours "8558"
assert_status 0 "$?" "port_already_ours: recognizes the publisher's own bound port"
# shellcheck disable=SC2218 # sourced from install.sh; this file redefines it locally further below for other cases
port_already_ours "3000"
assert_status 0 "$?" "port_already_ours: recognizes the hub's own bound port (unchanged)"
# shellcheck disable=SC2218 # sourced from install.sh; this file redefines it locally further below for other cases
port_already_ours "9999"
assert_status 1 "$?" "port_already_ours: a port none of our containers hold is not ours"

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
# shellcheck disable=SC2329 # invoked indirectly via the sourced install.sh
port_already_ours() { [[ "$1" == "3000" ]]; } # hub container from a prior install
out="$(check_ports 3000 8556 2>&1)"
rc=$?
assert_status 1 "$rc" "check_ports: still conflicts on 8556 even when 3000 is ours"
assert_not_contains "$out" $'\n3000 ' "check_ports: 3000 skipped — owned by our own hub container"
assert_contains "$out" "8556" "check_ports: 8556 still flagged (owned by something else)"

# --- Docker Desktop (macOS) lsof output ---------------------------------------
# lsof prints "com.docke" (9 chars) for com.docker.backend; vpnkit-bridge is
# the other process that can hold a published port. A port one of OUR
# containers publishes is not a conflict even though Desktop's backend (not
# docker-proxy) holds the socket; someone else's container still is, with a
# hint on how to find it.

have_ss() { return 1; } # macOS has no ss: collect_listeners must take the lsof path
# shellcheck disable=SC2329 # invoked indirectly by collect_listeners() in install.sh
run_lsof() { cat "$FIXTURES/lsof-darwin-docker.txt"; }
collect_listeners
assert_eq "com.docke" "${LISTEN_CMD[3000]:-}" "darwin lsof: truncated com.docker.backend command on 3000"
assert_eq "1234" "${LISTEN_PID[3000]:-}" "darwin lsof: Docker backend pid on 3000"
assert_eq "com.docker.backend" "${LISTEN_CMD[8557]:-}" "darwin lsof: full com.docker.backend command on 8557"
assert_eq "vpnkit-br" "${LISTEN_CMD[9000]:-}" "darwin lsof: IPv6 loopback listener on 9000 parsed"
assert_eq "ControlCe" "${LISTEN_CMD[7000]:-}" "darwin lsof: unrelated listener on 7000"

for cmd in com.docke com.docker.backend vpnkit-br vpnkit-bridge; do
  is_docker_desktop_listener "$cmd"
  assert_status 0 "$?" "is_docker_desktop_listener: ${cmd} is Docker Desktop's"
done
is_docker_desktop_listener "ControlCe"
assert_status 1 "$?" "is_docker_desktop_listener: ControlCe is not"

port_already_ours() { [[ "$1" == "3000" ]]; } # privos-hub published 3000 through Desktop's backend
out="$(check_ports 3000 8556 7000 2>&1)"
rc=$?
assert_status 1 "$rc" "darwin: a foreign Docker container and a foreign process still conflict"
assert_not_contains "$out" $'\n3000 ' "darwin: 3000 held by Desktop's backend for OUR hub is not a conflict"
assert_contains "$out" "8556" "darwin: 8556 (someone else's container) is flagged"
assert_contains "$out" "docker ps --filter publish=8556" "darwin: a Docker-published conflict says how to find the container"
assert_contains "$out" "7000" "darwin: 7000 (ControlCe) is flagged"
assert_not_contains "$out" "docker ps --filter publish=7000" "darwin: a non-Docker conflict gets no Docker hint"

check_ports 3000 >/dev/null 2>&1
assert_status 0 "$?" "darwin: re-running over our own hub on 3000 passes"

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
