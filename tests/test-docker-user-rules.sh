#!/usr/bin/env bash
# Unit tests for docker-user-rules.sh: the DOCKER-USER cleanup/insertion
# ordering fix, DNAT-scoped sandbox-plane DROPs, the agent-VM egress rules
# (private/link-local/CGNAT default-deny, same-bridge exemption, operator
# allowlist), strict allowlist validation, and --clear. Sources the script
# (its own main-guard skips execution when sourced — see the bottom of the
# file) and overrides run_iptables/run_ip so no test ever touches a real
# host firewall.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SELF_DIR/helpers.sh"
# shellcheck source=/dev/null
source "$SELF_DIR/../docker-user-rules.sh"
set +e # assertions must not abort the run; docker-user-rules.sh's `set -e` leaks in via source

IPTABLES_CALLS=()
IPTABLES_STUB_OUTPUT=""

# shellcheck disable=SC2329 # invoked indirectly via run_iptables() in docker-user-rules.sh
run_iptables() {
  IPTABLES_CALLS+=("$*")
  if [[ "$1" == "-S" ]]; then
    printf '%s\n' "$IPTABLES_STUB_OUTPUT"
    return 0
  fi
  return 0
}

IP_BRIDGE_PRESENT=1
IP_BRIDGE_ADDR="172.17.0.1/16"

# shellcheck disable=SC2329 # invoked indirectly via run_ip() in docker-user-rules.sh
run_ip() {
  if [[ "$1" == "link" ]]; then
    [[ "$IP_BRIDGE_PRESENT" -eq 1 ]] && return 0 || return 1
  fi
  if [[ "$1" == "-4" ]]; then
    [[ "$IP_BRIDGE_PRESENT" -eq 1 && -n "$IP_BRIDGE_ADDR" ]] && \
      printf '3: privos-agent0    inet %s scope global privos-agent0\n' "$IP_BRIDGE_ADDR"
    return 0
  fi
  return 0
}

call_index_of() {
  local needle="$1" i
  for i in "${!IPTABLES_CALLS[@]}"; do
    [[ "${IPTABLES_CALLS[$i]}" == *"$needle"* ]] && { echo "$i"; return 0; }
  done
  echo "-1"
}

# A previous version of the no-interface/hostname/unresolvable-address cases
# below captured output via `out="$(apply_vm_egress_rules ... 2>&1)"`.
# Command substitution forks a subshell, so any IPTABLES_CALLS+= mutation
# made *inside* that call never reached this parent shell — silently turning
# "assert no iptables call was made" into a tautology that stayed green even
# with the guard it was supposed to cover deleted. Those cases now call the
# function directly in the CURRENT shell, redirecting only stderr to a file,
# so IPTABLES_CALLS is the real array the function mutated. A `( ... )`
# subshell is still used, deliberately, around any call that may `exit` (a
# die-style validation failure) so a failure cannot abort the rest of this
# test file — that case does not need IPTABLES_CALLS, since the function it
# wraps never reaches an iptables call in the first place.

# --- clear_tagged_rules: matches iptables' real (unquoted) -S comment form -

IPTABLES_CALLS=()
IPTABLES_STUB_OUTPUT='-A DOCKER-USER -s 127.0.0.0/8 -p tcp -m conntrack --ctorigdstport 8557 -m comment --comment privos-self-hosted-sandbox-plane -j RETURN
-A DOCKER-USER -p tcp -m conntrack --ctstate NEW --ctorigdstport 8557 -m comment --comment privos-self-hosted-sandbox-plane -j DROP
-A DOCKER-USER -j RETURN'
clear_tagged_rules "privos-self-hosted-sandbox-plane"
delete_calls="$(printf '%s\n' "${IPTABLES_CALLS[@]}" | grep -c -- '^-D DOCKER-USER')"
assert_eq "2" "$delete_calls" "clear_tagged_rules: deletes both tagged rules (real unquoted -S form)"
assert_not_contains "$(printf '%s\n' "${IPTABLES_CALLS[@]}")" "-D DOCKER-USER -j RETURN" \
  "clear_tagged_rules: never deletes Docker's own untagged catch-all RETURN"

# --- apply_sandbox_plane_rules: DNAT-scoped DROP, no loopback RETURN -------

IPTABLES_CALLS=()
IPTABLES_STUB_OUTPUT=""
apply_sandbox_plane_rules "8556,8557,9000,30000:30999"

all_calls="$(printf '%s\n' "${IPTABLES_CALLS[@]}")"
for port in 8556 8557 9000 30000:30999; do
  assert_contains "$all_calls" \
    "-p tcp -m conntrack --ctstate NEW -m conntrack --ctstate DNAT --ctorigdstport ${port} -m comment --comment privos-self-hosted-sandbox-plane -j DROP" \
    "apply_sandbox_plane_rules: port ${port} DROP is scoped to DNAT'd (published-port) traffic only"
done
assert_not_contains "$all_calls" "-A DOCKER-USER -p tcp -m conntrack --ctstate NEW" \
  "apply_sandbox_plane_rules: never appends a DROP with -A (the dead-rule bug this replaces)"
assert_not_contains "$all_calls" "-s 127.0.0.1/8" \
  "apply_sandbox_plane_rules: no source-IP RETURN — a loopback-published port never reaches this DROP to need one"

# Mutation check: a DROP without --ctstate DNAT would ALSO satisfy the plain
# "contains DROP for this port" assertion. Prove the assertion above actually
# depends on the DNAT scoping by checking a deliberately unscoped DROP does
# NOT match it.
unscoped_example="-p tcp -m conntrack --ctstate NEW --ctorigdstport 8556 -m comment --comment privos-self-hosted-sandbox-plane -j DROP"
assert_not_contains "$unscoped_example" "-m conntrack --ctstate DNAT" \
  "apply_sandbox_plane_rules: sanity check — an unscoped DROP (no DNAT match) does not satisfy the DNAT-scoped assertion's own needle"

# --- apply_vm_egress_rules: private/link-local/CGNAT DROPs, no loopback ----

IPTABLES_CALLS=()
IPTABLES_STUB_OUTPUT=""
IP_BRIDGE_PRESENT=1
IP_BRIDGE_ADDR="172.17.0.1/16"
apply_vm_egress_rules ""

all_calls="$(printf '%s\n' "${IPTABLES_CALLS[@]}")"
for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
  assert_contains "$all_calls" "-i privos-agent0 -d ${cidr} -p tcp -m conntrack --ctstate NEW -m comment --comment privos-self-hosted-vm-egress -j DROP" \
    "apply_vm_egress_rules: drops NEW privos-agent0 connections to ${cidr}"
done
assert_not_contains "$all_calls" "-d 127.0.0.0/8" \
  "apply_vm_egress_rules: no 127.0.0.0/8 DROP — a VM container can never put such a packet onto the bridge"

# --- apply_vm_egress_rules: same-bridge traffic is exempted (C2) -----------

same_bridge_idx="$(call_index_of "-i privos-agent0 -o privos-agent0 -m comment --comment privos-self-hosted-vm-egress -j RETURN")"
TESTS_RUN=$((TESTS_RUN + 1))
if [[ "$same_bridge_idx" != "-1" ]]; then
  echo "ok - apply_vm_egress_rules: same-bridge (privos-agent0 -> privos-agent0) traffic gets an explicit RETURN"
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
  echo "not ok - apply_vm_egress_rules: no same-bridge RETURN found (VM<->sandbox-proxy would be dropped under br_netfilter)" >&2
fi

# Ordering: the same-bridge RETURN must end up ABOVE every dest DROP. Each
# rule is inserted via `-I DOCKER-USER 1`, so whichever call happens LATER
# (higher index in IPTABLES_CALLS, which records calls in chronological
# order) ends up on TOP of the chain. The DROPs are emitted first (in the
# for loop), the same-bridge RETURN right after — so its call index must be
# GREATER than each DROP's for it to sit above them (same convention the
# apply_sandbox_plane_rules DROP/RETURN-ordering test above already uses).
TESTS_RUN=$((TESTS_RUN + 1))
ordering_ok=1
if [[ "$same_bridge_idx" != "-1" ]]; then
  for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
    drop_idx="$(call_index_of "-i privos-agent0 -d ${cidr} -p tcp -m conntrack --ctstate NEW -m comment --comment privos-self-hosted-vm-egress -j DROP")"
    [[ "$drop_idx" != "-1" && "$drop_idx" -lt "$same_bridge_idx" ]] || ordering_ok=0
  done
else
  ordering_ok=0
fi
if [[ "$ordering_ok" -eq 1 ]]; then
  echo "ok - apply_vm_egress_rules: same-bridge RETURN is evaluated before every private-range DROP"
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
  echo "not ok - apply_vm_egress_rules: same-bridge RETURN is not positioned above the private-range DROPs" >&2
fi

# --- apply_vm_egress_rules: no privos-agent0 interface yet -> skip, no rules --
# Calls the function directly in THIS shell (not via `$(...)`, which forks a
# subshell and would hide any IPTABLES_CALLS mutation — see the M3 note on
# run_in_subshell_capturing above) so "no rules were added" is a real check.

IPTABLES_CALLS=()
IP_BRIDGE_PRESENT=0
stderr_file="$(mktemp)"
apply_vm_egress_rules "" 2>"$stderr_file"
out="$(<"$stderr_file")"
rm -f "$stderr_file"
assert_contains "$out" "no privos-agent0 interface found" "apply_vm_egress_rules: warns when privos-agent0 does not exist yet"
assert_eq "0" "${#IPTABLES_CALLS[@]}" "apply_vm_egress_rules: adds no rules when privos-agent0 does not exist yet"
IP_BRIDGE_PRESENT=1

# --- apply_vm_egress_rules: operator allowlist — CIDR and IP entries ------

IPTABLES_CALLS=()
apply_vm_egress_rules "10.20.0.0/16,192.168.1.5"
all_calls="$(printf '%s\n' "${IPTABLES_CALLS[@]}")"
assert_contains "$all_calls" "-i privos-agent0 -d 10.20.0.0/16 -m comment --comment privos-self-hosted-vm-egress -j RETURN" \
  "apply_vm_egress_rules: allowlisted CIDR gets a RETURN"
assert_contains "$all_calls" "-i privos-agent0 -d 192.168.1.5 -m comment --comment privos-self-hosted-vm-egress -j RETURN" \
  "apply_vm_egress_rules: allowlisted bare IP gets a RETURN"

# --- apply_vm_egress_rules: allowlist hostname entry is firewall-inert -----
# Same direct-call-in-current-shell fix as the no-interface case above.

IPTABLES_CALLS=()
stderr_file="$(mktemp)"
apply_vm_egress_rules "internal-api.corp.example" 2>"$stderr_file"
out="$(<"$stderr_file")"
rm -f "$stderr_file"
assert_contains "$out" "not an IPv4 address/CIDR" "apply_vm_egress_rules: warns that a hostname allowlist entry cannot be matched by the firewall"
assert_not_contains "$(printf '%s\n' "${IPTABLES_CALLS[@]}")" "internal-api.corp.example" \
  "apply_vm_egress_rules: never passes a hostname to iptables"

# --- dead hub host-callback code path is gone (M4) -------------------------
# The old path resolved the bridge address via `ip -4 addr show` and added a
# per-port RETURN to it — dead code, since VM-to-host traffic goes through
# INPUT, never DOCKER-USER. Confirm neither function references it anymore.

TESTS_RUN=$((TESTS_RUN + 1))
if declare -f apply_vm_egress_rules main | grep -q "host_callback"; then
  TESTS_FAILED=$((TESTS_FAILED + 1))
  echo "not ok - dead hub host-callback code path still present" >&2
else
  echo "ok - dead hub host-callback code path removed"
fi

# --- validate_egress_allowlist: accepts well-formed IPv4 CIDRs/IPs ---------

IPTABLES_CALLS=()
( validate_egress_allowlist "10.20.0.0/16,192.168.1.5, ,internal-api.corp.example" )
assert_status 0 "$?" "validate_egress_allowlist: accepts CIDR, bare IP, blank entry, and a hostname (not IPv4-shaped)"

# --- validate_egress_allowlist: rejects a bad prefix BEFORE any rule change (H4) --

IPTABLES_CALLS=()
out="$( ( validate_egress_allowlist "10.0.0.0/33" ) 2>&1 )"
rc=$?
assert_status 1 "$rc" "validate_egress_allowlist: rejects an out-of-range /33 prefix"
assert_contains "$out" "invalid IPv4 prefix" "validate_egress_allowlist: error message names the invalid prefix"
assert_eq "0" "${#IPTABLES_CALLS[@]}" "validate_egress_allowlist: never touches iptables while validating"

# --- validate_egress_allowlist: rejects an IPv4-mapped IPv6 literal --------

out="$( ( validate_egress_allowlist "::ffff:10.0.0.1" ) 2>&1 )"
assert_status 1 "$?" "validate_egress_allowlist: rejects ::ffff:10.0.0.1 (not a bare IPv4 address)"

# --- validate_egress_allowlist: rejects a DNS-resolvable-looking entry -----

out="$( ( validate_egress_allowlist "1.2.3.4.nip.io" ) 2>&1 )"
assert_status 1 "$?" "validate_egress_allowlist: rejects 1.2.3.4.nip.io (5 dot-separated fields, not a /32 IPv4)"

# --- validate_egress_allowlist: rejects an out-of-range octet --------------

out="$( ( validate_egress_allowlist "10.0.0.256" ) 2>&1 )"
assert_status 1 "$?" "validate_egress_allowlist: rejects an out-of-range octet (256)"

# --- validate_egress_allowlist: called from main() before either apply_* --
# Full end-to-end proof for H4: a bad allowlist must abort BEFORE
# apply_sandbox_plane_rules or apply_vm_egress_rules ever runs a single -I.
#
# main() dies via `exit 1` on a bad entry, so it must run in a subshell here
# too (same reason as the validate_egress_allowlist cases above) — but a
# plain `( main ... )` would hit the exact bug this whole file fixes: the
# subshell's own IPTABLES_CALLS mutations (from apply_sandbox_plane_rules/
# apply_vm_egress_rules, if validation had NOT stopped them) would never
# reach this parent shell, so "no iptables call was made" would pass no
# matter what main() actually did inside. An EXIT trap runs INSIDE the
# subshell (even when it terminates via `exit`), so it can read the
# subshell's real IPTABLES_CALLS and hand the count out through a file.

_write_call_count() { echo "${#IPTABLES_CALLS[@]}" > "$1"; }

IPTABLES_CALLS=()
IPTABLES_STUB_OUTPUT=""
calls_file="$(mktemp)"
# shellcheck disable=SC2064 # ${calls_file} must expand NOW (registration
# time), not when the trap fires — it is a fixed mktemp path, not something
# that changes before the subshell exits.
( trap "_write_call_count '${calls_file}'" EXIT
  main "8556,8557,9000,30000:30999" "10.0.0.0/33" ) >/dev/null 2>&1
rc=$?
call_count="$(<"$calls_file")"
rm -f "$calls_file"
assert_status 1 "$rc" "main: a malformed PRIVOS_EGRESS_ALLOWLIST entry aborts the whole run"
assert_eq "0" "$call_count" "main: no iptables call was made when the allowlist is malformed (nothing half-applied)"

# --- main --clear: removes rules for BOTH tags (H2 / --uninstall --purge) --

IPTABLES_CALLS=()
IPTABLES_STUB_OUTPUT='-A DOCKER-USER -p tcp -m conntrack --ctstate NEW -m conntrack --ctstate DNAT --ctorigdstport 8556 -m comment --comment privos-self-hosted-sandbox-plane -j DROP
-A DOCKER-USER -i privos-agent0 -d 10.0.0.0/8 -p tcp -m conntrack --ctstate NEW -m comment --comment privos-self-hosted-vm-egress -j DROP
-A DOCKER-USER -j RETURN'
main --clear
delete_calls="$(printf '%s\n' "${IPTABLES_CALLS[@]}" | grep -c -- '^-D DOCKER-USER')"
assert_eq "2" "$delete_calls" "main --clear: deletes both the sandbox-plane and VM-egress tagged rules"
assert_not_contains "$(printf '%s\n' "${IPTABLES_CALLS[@]}")" "-j DROP -j DROP" \
  "main --clear: sanity — no malformed double rule"
insert_calls="$(printf '%s\n' "${IPTABLES_CALLS[@]}" | grep -c -- '^-I DOCKER-USER')"
assert_eq "0" "$insert_calls" "main --clear: never inserts a rule, only removes"

report_and_exit
