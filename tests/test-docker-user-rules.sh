#!/usr/bin/env bash
# Unit tests for docker-user-rules.sh: the DOCKER-USER cleanup/insertion
# ordering fix, and the new agent-VM egress rules (private/link-local/CGNAT
# default-deny, operator allowlist, hub host-callback exception). Sources
# the script (its own main-guard skips execution when sourced — see the
# bottom of the file) and overrides run_iptables/run_ip so no test ever
# touches a real host firewall.
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

IP_DOCKER0_PRESENT=1
IP_DOCKER0_ADDR="172.17.0.1/16"

# shellcheck disable=SC2329 # invoked indirectly via run_ip() in docker-user-rules.sh
run_ip() {
  if [[ "$1" == "link" ]]; then
    [[ "$IP_DOCKER0_PRESENT" -eq 1 ]] && return 0 || return 1
  fi
  if [[ "$1" == "-4" ]]; then
    [[ "$IP_DOCKER0_PRESENT" -eq 1 && -n "$IP_DOCKER0_ADDR" ]] && \
      printf '3: docker0    inet %s scope global docker0\n' "$IP_DOCKER0_ADDR"
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

# --- clear_tagged_rules: the OLD quoted-comment grep pattern regression ----
# (documents the bug this fix replaces: a pattern requiring literal quotes
# around the comment value would find zero matches against real -S output)

assert_contains "$IPTABLES_STUB_OUTPUT" '--comment privos-self-hosted-sandbox-plane' \
  "clear_tagged_rules: fixture reproduces iptables' real unquoted comment form"
assert_not_contains "$IPTABLES_STUB_OUTPUT" '--comment "privos-self-hosted-sandbox-plane"' \
  "clear_tagged_rules: fixture does NOT contain the quoted form the old buggy grep required"

# --- apply_sandbox_plane_rules: RETURN inserted after DROP (ends up above) -

IPTABLES_CALLS=()
IPTABLES_STUB_OUTPUT=""
apply_sandbox_plane_rules "8556,8557,9000,30000:30999"

for port in 8556 8557 9000 30000:30999; do
  drop_idx="$(call_index_of "ctorigdstport ${port} -m comment --comment privos-self-hosted-sandbox-plane -j DROP")"
  return_idx="$(call_index_of "ctorigdstport ${port} -m comment --comment privos-self-hosted-sandbox-plane -j RETURN")"
  assert_true=1
  [[ "$drop_idx" != "-1" && "$return_idx" != "-1" && "$drop_idx" -lt "$return_idx" ]] && assert_true=0
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$assert_true" -eq 0 ]]; then
    echo "ok - apply_sandbox_plane_rules: port ${port} RETURN inserted after (ends up above) its DROP"
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    echo "not ok - apply_sandbox_plane_rules: port ${port} RETURN/DROP ordering wrong (drop_idx=${drop_idx} return_idx=${return_idx})" >&2
  fi
done

all_calls="$(printf '%s\n' "${IPTABLES_CALLS[@]}")"
assert_not_contains "$all_calls" "-A DOCKER-USER -p tcp -m conntrack --ctstate NEW" \
  "apply_sandbox_plane_rules: never appends a DROP with -A (the dead-rule bug this replaces)"

# --- apply_vm_egress_rules: private/link-local/CGNAT/loopback DROPs -------

IPTABLES_CALLS=()
IPTABLES_STUB_OUTPUT=""
IP_DOCKER0_PRESENT=1
IP_DOCKER0_ADDR="172.17.0.1/16"
apply_vm_egress_rules "" "3000"

all_calls="$(printf '%s\n' "${IPTABLES_CALLS[@]}")"
for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8; do
  assert_contains "$all_calls" "-i docker0 -d ${cidr} -p tcp -m conntrack --ctstate NEW -m comment --comment privos-self-hosted-vm-egress -j DROP" \
    "apply_vm_egress_rules: drops NEW docker0 connections to ${cidr}"
done
assert_contains "$all_calls" "-i docker0 -d 172.17.0.1 -p tcp --dport 3000 -m comment --comment privos-self-hosted-vm-egress -j RETURN" \
  "apply_vm_egress_rules: allows the hub host-callback via the docker0 bridge address"

# --- apply_vm_egress_rules: no docker0 interface yet -> skip, no rules ----

IPTABLES_CALLS=()
IP_DOCKER0_PRESENT=0
out="$(apply_vm_egress_rules "" "3000" 2>&1)"
assert_contains "$out" "no docker0 interface found" "apply_vm_egress_rules: warns when docker0 does not exist yet"
assert_eq "0" "${#IPTABLES_CALLS[@]}" "apply_vm_egress_rules: adds no rules when docker0 does not exist yet"
IP_DOCKER0_PRESENT=1

# --- apply_vm_egress_rules: operator allowlist — CIDR and IP entries ------

IPTABLES_CALLS=()
apply_vm_egress_rules "10.20.0.0/16,192.168.1.5" "3000"
all_calls="$(printf '%s\n' "${IPTABLES_CALLS[@]}")"
assert_contains "$all_calls" "-i docker0 -d 10.20.0.0/16 -m comment --comment privos-self-hosted-vm-egress -j RETURN" \
  "apply_vm_egress_rules: allowlisted CIDR gets a RETURN"
assert_contains "$all_calls" "-i docker0 -d 192.168.1.5 -m comment --comment privos-self-hosted-vm-egress -j RETURN" \
  "apply_vm_egress_rules: allowlisted bare IP gets a RETURN"

# --- apply_vm_egress_rules: allowlist hostname entry is firewall-inert -----

IPTABLES_CALLS=()
out="$(apply_vm_egress_rules "internal-api.corp.example" "3000" 2>&1)"
assert_contains "$out" "not an IPv4 address/CIDR" "apply_vm_egress_rules: warns that a hostname allowlist entry cannot be matched by the firewall"
assert_not_contains "$(printf '%s\n' "${IPTABLES_CALLS[@]}")" "internal-api.corp.example" \
  "apply_vm_egress_rules: never passes a hostname to iptables"

# --- apply_vm_egress_rules: multiple host-callback ports -------------------

IPTABLES_CALLS=()
apply_vm_egress_rules "" "3000,3001"
all_calls="$(printf '%s\n' "${IPTABLES_CALLS[@]}")"
assert_contains "$all_calls" "--dport 3000 -m comment --comment privos-self-hosted-vm-egress -j RETURN" \
  "apply_vm_egress_rules: first host-callback port allowed"
assert_contains "$all_calls" "--dport 3001 -m comment --comment privos-self-hosted-vm-egress -j RETURN" \
  "apply_vm_egress_rules: second host-callback port allowed"

# --- apply_vm_egress_rules: docker0 address unresolvable -------------------

IPTABLES_CALLS=()
IP_DOCKER0_ADDR=""
out="$(apply_vm_egress_rules "" "3000" 2>&1)"
assert_contains "$out" "could not determine docker0's address" "apply_vm_egress_rules: warns when docker0 has no address yet"
assert_not_contains "$(printf '%s\n' "${IPTABLES_CALLS[@]}")" "--dport 3000" \
  "apply_vm_egress_rules: adds no host-callback RETURN when docker0's address is unknown"
IP_DOCKER0_ADDR="172.17.0.1/16"

report_and_exit
