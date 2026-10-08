#!/usr/bin/env bash
# Runs ON the self-hosted install host. Locks the sandbox plane (board,
# proxy, RustFS, VM pool range) to loopback-only at the DOCKER-USER level, as
# a backstop against a LATER `ports:` edit in compose.yml republishing one of
# them on 0.0.0.0 — the compose.yml bind (127.0.0.1:PORT:PORT) is the primary
# control; this is defense-in-depth so a manual edit mistake alone cannot
# expose the sandbox plane off-host. It also restricts EGRESS from agent VM
# containers to private/link-local/carrier-grade-NAT destinations, so a
# prompt-injected agent's Bash tool (which has no in-process SSRF guard of
# its own — see packages/agentic-sdk in privos-sandbox) cannot reach the
# operator's LAN or cloud metadata by opening a raw TCP connection. Both
# layers are IPv4/TCP only: UDP, ICMP and IPv6 are not filtered here.
#
# Modelled on infra/node-onboarding/restrict-published-tenant-ports.sh — same
# reasoning applies here:
#   - Docker publishes ports via DNAT in PREROUTING, so the traffic traverses
#     FORWARD and never reaches ufw's INPUT chain; a plain ufw rule does
#     nothing to a published container port.
#   - after DNAT the packet carries the CONTAINER port, so matching --dport
#     in DOCKER-USER matches nothing; conntrack's --ctorigdstport still knows
#     the port the client aimed at.
#   - reply traffic carries the same original destination port, so an
#     unqualified DROP kills the responses of the connections it just
#     allowed. Only NEW connections may be judged.
#
# Unlike the tenant-ports script (an operator-supplied allowlist of trusted
# source IPs), the sandbox plane has no legitimate DNAT'd source at all:
# these ports are compose-bound to 127.0.0.1 only, and a loopback-originated
# connection to a loopback-published port never enters FORWARD in the first
# place (docker-proxy handles it in userspace, or it is DNAT'd in OUTPUT when
# userland-proxy is off — neither traverses DOCKER-USER). So every NEW,
# DNAT'd connection this chain sees for these ports is by definition the
# 0.0.0.0 misconfiguration this script guards against.
set -euo pipefail

SANDBOX_PLANE_TAG="privos-self-hosted-sandbox-plane"
VM_EGRESS_TAG="privos-self-hosted-vm-egress"

# Host interface for the dedicated agent-VM bridge network (compose.yml's
# `privos-agent-net`, `driver_opts.com.docker.network.bridge.name`). Fixed at
# network-creation time via that driver opt specifically so this script never
# has to resolve it at runtime (e.g. `docker network inspect ... .Id` + the
# `br-<id>` convention) — a plain constant here stays correct as long as
# compose.yml keeps pinning the same name.
VM_BRIDGE_IFACE="privos-agent0"

# Thin indirection over the two external commands this script shells out to,
# purely so tests/test-docker-user-rules.sh can override them and assert on
# the exact invocations made without mutating a real host firewall (same
# reason tests/test-port-check.sh overrides run_ss/run_lsof instead of
# calling `ss`/`lsof` for real).
# PRIVOS_IPTABLES selects the backend binary (iptables-nft / iptables-legacy);
# --loop resolves it itself, see select_iptables_backend.
run_iptables() { "${PRIVOS_IPTABLES:-iptables}" "$@"; }
run_ip() { ip "$@"; }

# Trims leading/trailing whitespace from a comma-list entry. Shared by
# validate_egress_allowlist and apply_vm_egress_rules so both agree on what
# counts as "the same entry".
_trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Deletes every DOCKER-USER rule carrying $1 as its --comment value.
#
# `iptables -S` never quotes a comment value that has no spaces — it prints
# `--comment some-tag`, not `--comment "some-tag"`. A prior version of this
# function grepped for the quoted form, which never matched anything, so the
# "start clean" step silently deleted zero rules and every re-run (a second
# install.sh pass, a reboot re-applying the systemd unit) piled another
# full copy of every rule onto the chain. Confirmed live on a running
# install: two `apply()` calls left 16 tagged rules instead of 8. Match the
# unquoted form iptables actually prints.
clear_tagged_rules() {
  local tag="$1" rule
  while read -r rule; do
    [[ -n "$rule" ]] || continue
    # shellcheck disable=SC2086 # the -S output is re-fed as iptables arguments
    run_iptables -D DOCKER-USER ${rule#-A DOCKER-USER } 2>/dev/null || true
  done < <(run_iptables -S DOCKER-USER 2>/dev/null | grep -- "--comment $tag")
}

# Rejects any PRIVOS_EGRESS_ALLOWLIST entry that LOOKS like an IPv4
# address/CIDR (the same "does it contain 3 dots" shape check
# apply_vm_egress_rules uses below) but is not a well-formed one — checked
# FIRST in main(), before either apply_* function ever runs a single `-I` or
# `-D`, so a typo can never leave the chain half up (one tag cleared and
# reinserted, the other left stale) and iptables never sees an entry it
# would either reject outright (10.0.0.0/33) or resolve via a live DNS
# lookup at insertion time (1.2.3.4.nip.io). Hostname and IPv6 entries (which
# do not match the shape check) are left alone here — this firewall cannot
# act on either kind, but neither is a typo'd IPv4 entry, so neither should
# abort the install; apply_vm_egress_rules warns about them per-entry
# instead.
validate_egress_allowlist() {
  local egress_allowlist="$1" entry ip prefix octet
  local -a entries octets
  IFS=',' read -ra entries <<< "$egress_allowlist"
  for entry in ${entries[@]+"${entries[@]}"}; do
    entry="$(_trim "$entry")"
    [[ -z "$entry" ]] && continue
    [[ "$entry" == *.*.*.* ]] || continue

    ip="$entry"
    if [[ "$entry" == */* ]]; then
      ip="${entry%%/*}"
      prefix="${entry#*/}"
      if [[ ! "$prefix" =~ ^[0-9]+$ ]] || (( 10#$prefix > 32 )); then
        echo "ERROR: PRIVOS_EGRESS_ALLOWLIST entry '${entry}' has an invalid IPv4 prefix (must be 0-32)" >&2
        exit 1
      fi
    fi

    IFS='.' read -ra octets <<< "$ip"
    if [[ "${#octets[@]}" -ne 4 ]]; then
      echo "ERROR: PRIVOS_EGRESS_ALLOWLIST entry '${entry}' is not a valid IPv4 address/CIDR" >&2
      exit 1
    fi
    for octet in "${octets[@]}"; do
      if [[ ! "$octet" =~ ^[0-9]+$ ]]; then
        echo "ERROR: PRIVOS_EGRESS_ALLOWLIST entry '${entry}' contains a non-numeric IPv4 octet '${octet}'" >&2
        exit 1
      fi
      if (( 10#$octet > 255 )); then
        echo "ERROR: PRIVOS_EGRESS_ALLOWLIST entry '${entry}' has an out-of-range IPv4 octet '${octet}' (must be 0-255)" >&2
        exit 1
      fi
    done
  done
}

# VM_EGRESS_MODE is `open` (default, also when unset/empty: today's rules
# only) or `enforce` (adds a full DROP for anything leaving the agent bridge).
# Anything else aborts, checked in main() before a single rule changes, so a
# typo can never silently fall back to open on a host that meant enforce.
validate_vm_egress_mode() {
  case "${VM_EGRESS_MODE:-open}" in
    open|enforce) ;;
    *)
      echo "ERROR: VM_EGRESS_MODE '${VM_EGRESS_MODE}' is invalid (must be 'open' or 'enforce')" >&2
      exit 1
      ;;
  esac
}

apply_sandbox_plane_rules() {
  local protected_ports="$1"
  clear_tagged_rules "$SANDBOX_PLANE_TAG"

  IFS=',' read -ra ports <<< "$protected_ports"
  for p in "${ports[@]}"; do
    # iptables/conntrack port RANGES use a colon (30000:30999); a dash makes
    # iptables treat it as a service name -> "Port 30000-30999 does not resolve
    # to anything". Normalize either form to the colon iptables wants.
    port_range="${p/-/:}"
    # Docker inserts exactly one unconditional `-A DOCKER-USER -j RETURN` the
    # first time it ever touches this chain on Engine < 28 (28+ no longer
    # adds it — see the moby changes cited in the module this ships from).
    # `-A` (append) ALWAYS lands after that rule on the older engines, which
    # makes an appended DROP unreachable there. `-I DOCKER-USER 1` (insert at
    # the top) is the only placement that runs on every supported engine.
    #
    # `--ctstate DNAT`, as its OWN `-m conntrack` (ANDed with the `NEW`
    # check, not OR'd into one `--ctstate` list — a comma list is an OR),
    # restricts the match to traffic Docker itself redirected in from a
    # published port. Without it, DOCKER-USER sees every forwarded packet on
    # the host, so `--ctorigdstport` alone also matches an unrelated
    # container's own OUTBOUND connection to a remote host whose port
    # happens to be 9000/8556/8557/30000-30999, and — on hosts where
    # br_netfilter is loaded — same-bridge container-to-container traffic
    # between two PrivOS services that never went through DNAT at all.
    #
    # No source-IP RETURN is needed above this DROP: these ports are
    # compose-bound to 127.0.0.1 only, and a loopback-originated connection
    # to a loopback-published port is served by docker-proxy in userspace, or
    # DNAT'd in OUTPUT when userland-proxy is off — neither path traverses
    # FORWARD/DOCKER-USER, so it never reaches this DROP in the first place.
    run_iptables -I DOCKER-USER 1 -p tcp -m conntrack --ctstate NEW -m conntrack --ctstate DNAT \
      --ctorigdstport "$port_range" -m comment --comment "$SANDBOX_PLANE_TAG" -j DROP
  done
}

# Agent VM containers are spawned by sandbox-proxy directly via the Docker
# API (not through compose), attached to compose.yml's dedicated
# `privos-agent-net` bridge network (VM_NETWORK on sandbox-proxy) — a
# separate bridge from the named `privos` network the rest of the stack
# (hub, mongo, redis, rustfs, board, proxy) runs on, so agent VM containers
# can never reach Mongo/Redis/RustFS directly (Docker's inter-bridge
# isolation, independent of anything in this file). compose.yml pins that
# network's host-side interface name to $VM_BRIDGE_IFACE via
# `driver_opts.com.docker.network.bridge.name` specifically so this script
# can match it by a fixed name instead of resolving it at runtime (a plain
# compose-managed bridge otherwise gets an opaque `br-<network-id>` name
# assigned at creation time).
apply_vm_egress_rules() {
  local egress_allowlist="$1"
  clear_tagged_rules "$VM_EGRESS_TAG"

  if ! run_ip link show "$VM_BRIDGE_IFACE" >/dev/null 2>&1; then
    echo "WARNING: no ${VM_BRIDGE_IFACE} interface found — skipping agent VM egress rules (Docker creates the privos-agent-net bridge when the sandbox stack first comes up; re-run this script, or install.sh, after that)" >&2
    return 0
  fi

  # RFC1918 + carrier-grade NAT (100.64.0.0/10) + link-local (169.254.0.0/16,
  # which covers the 169.254.169.254 cloud-metadata address on every major
  # cloud). Anything NOT in one of these ranges — the public internet,
  # including the LLM gateway agents call — is left untouched: Docker's own
  # catch-all RETURN (see the comment in apply_sandbox_plane_rules above)
  # lets it through once these DROPs don't match.
  #
  # 127.0.0.0/8 is deliberately NOT in this list: a container can only send a
  # packet addressed to 127/8 to its OWN loopback (its own network
  # namespace) — it can never put such a packet onto the bridge, so a DROP
  # for it here could never match anything. A VM reaching the HOST itself
  # over the bridge's gateway address goes through INPUT, which this script
  # does not touch.
  #
  # Same top-first insertion reasoning as apply_sandbox_plane_rules: every
  # rule below is added via `-I DOCKER-USER 1`, never `-A`, or it would land
  # after — and be shadowed by — Docker's own RETURN on Engine < 28.
  # enforce: nothing may leave the agent bridge. Agent VMs reach sandbox-proxy
  # (its forward-listener port and API port) and Mongo only because both sit
  # on this same bridge, so that traffic never leaves it and is covered by the
  # same-bridge RETURN further down. Inserted FIRST so it ends up at the
  # bottom of this script's rules: the same-bridge RETURN and the
  # private-range DROPs below are evaluated before it. The operator allowlist
  # RETURNs are NOT inserted in enforce mode (deny-by-default: un-credentialed
  # destinations go through the proxy forward listener and the hub setting
  # PrivOSSandbox_Egress_Allowed_Hosts, never straight from a VM). All
  # protocols (not only TCP) and not limited to NEW.
  # NOTE: sandbox-proxy's own default route must not run over this bridge, or
  # its public egress (LLM gateway, hub) is dropped here too.
  if [[ "${VM_EGRESS_MODE:-open}" == "enforce" ]]; then
    echo "WARNING: VM_EGRESS_MODE=enforce — dropping ALL traffic leaving ${VM_BRIDGE_IFACE}; PRIVOS_EGRESS_ALLOWLIST is not applied to agent VMs in this mode; sandbox-proxy must reach the internet over its other network" >&2
    run_iptables -I DOCKER-USER 1 -i "$VM_BRIDGE_IFACE" ! -o "$VM_BRIDGE_IFACE" \
      -m comment --comment "$VM_EGRESS_TAG" -j DROP
  fi

  for dest in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
    run_iptables -I DOCKER-USER 1 -i "$VM_BRIDGE_IFACE" -d "$dest" -p tcp -m conntrack --ctstate NEW \
      -m comment --comment "$VM_EGRESS_TAG" -j DROP
  done

  # Exempt same-bridge traffic. sandbox-proxy is a member of BOTH `privos`
  # and `privos-agent-net`, so agent VM containers reach it directly by its
  # Docker-DNS name over privos-agent-net (VM -> sandbox-proxy:8557 for the
  # LLM relay and hub/skill egress; sandbox-proxy -> VM:8556 to dispatch
  # attempts). On a host with br_netfilter loaded, bridged frames between two
  # containers on the SAME bridge still traverse FORWARD — and therefore
  # DOCKER-USER — before Docker's own inter-container ACCEPT rule ever runs;
  # DOCKER-USER is consulted first. Without this RETURN, the DROPs above
  # would also catch that path, because privos-agent-net's subnet (Docker's
  # default pool range) falls inside 172.16.0.0/12 or 192.168.0.0/16, and the
  # built-in agent would never work on such a host. Inserted (via `-I 1`)
  # AFTER the DROPs above, so it ends up above them in the chain and is
  # evaluated first.
  run_iptables -I DOCKER-USER 1 -i "$VM_BRIDGE_IFACE" -o "$VM_BRIDGE_IFACE" \
    -m comment --comment "$VM_EGRESS_TAG" -j RETURN

  # Operator allowlist last, so these RETURNs end up checked FIRST (every
  # insertion here uses -I 1; whatever is inserted last ends up on top).
  #
  # The SAME env var (PRIVOS_EGRESS_ALLOWLIST), read from the same .env file,
  # is also forwarded by compose.yml into sandbox-proxy/sandbox-board for the
  # in-process WebFetch guard inside privos-sandbox
  # (packages/agentic-sdk/src/lib/outbound-host-guard.ts), which additionally
  # accepts hostname entries this firewall cannot match on its own — but only
  # on a sandbox image built from a commit that includes that guard; an older
  # image ignores the variable entirely. The two layers still don't fully
  # agree even then: the WebFetch guard never admits loopback or link-local
  # regardless of this setting, while this firewall opens whatever CIDR is
  # listed, including 127.0.0.0/8 or 169.254.0.0/16 if an operator lists one.
  [[ "${VM_EGRESS_MODE:-open}" == "enforce" ]] && return 0
  IFS=',' read -ra allow_entries <<< "$egress_allowlist"
  for entry in ${allow_entries[@]+"${allow_entries[@]}"}; do
    entry="$(_trim "$entry")"
    [[ -z "$entry" ]] && continue
    if [[ "$entry" != *.*.*.* ]]; then
      # Not IPv4-CIDR/IP-shaped (this firewall layer is IPv4-only, matching
      # the rest of this script) — a hostname or IPv6 entry, meaningful only
      # to the in-process WebFetch guard once it receives this variable, not
      # to iptables.
      echo "WARNING: PRIVOS_EGRESS_ALLOWLIST entry '$entry' is not an IPv4 address/CIDR — the host firewall cannot match it and will ignore it here" >&2
      continue
    fi
    run_iptables -I DOCKER-USER 1 -i "$VM_BRIDGE_IFACE" -d "$entry" \
      -m comment --comment "$VM_EGRESS_TAG" -j RETURN
  done
}

# iptables rules do not survive a reboot, and Docker recreates DOCKER-USER
# empty when it restarts, so reapply on boot and after docker. Installs a
# oneshot systemd unit that re-invokes this same script with the same
# arguments; a no-op (with a loud warning) on a host with no systemd, or when
# this script was piped over stdin rather than run from a real file.
persist_rules() {
  local protected_ports="$1" egress_allowlist="$2"

  # Piping this script over stdin leaves $0 as "bash", so the rules apply but
  # the unit cannot be installed. Say so loudly instead of failing with an
  # obscure `install: cannot stat 'bash'` after the rules are already live.
  if [[ ! -r "$0" || "$0" == bash || "$0" == sh ]]; then
    echo "WARNING: rules applied but NOT made persistent — install.sh copies this script to disk before running it; if you invoked it manually over a pipe, copy it to a file and run it from there to install the boot unit" >&2
    run_iptables -L DOCKER-USER -n --line-numbers | tail -n +3
    return 0
  fi
  # No systemd (containers, some minimal/alternative-init distros): the rules are
  # live for this boot but there is nothing to persist them with. Say so and stop
  # here instead of dying on `systemctl` under set -e after the rules are applied.
  if ! command -v systemctl >/dev/null 2>&1 || [[ ! -d /run/systemd/system ]]; then
    echo "WARNING: no systemd on this host — rules applied for this boot only; re-run install.sh (or this script) after each reboot to reapply" >&2
    run_iptables -L DOCKER-USER -n --line-numbers | tail -n +3
    return 0
  fi
  if [[ "$(readlink -f "$0")" == /usr/local/sbin/privos-restrict-sandbox-plane.sh ]]; then
    # Invoked by the boot unit itself: the rules above are already
    # (re)applied for this boot, and the unit is already installed.
    # Re-running `install` here would copy this file onto itself — GNU
    # install refuses with "are the same file" under `set -e`, which would
    # mark the unit failed on every single boot despite the rules having
    # been applied correctly, and a `systemctl daemon-reload` from inside a
    # starting unit is also unnecessary work. Same guard as
    # infra/node-onboarding/restrict-published-tenant-ports.sh, which has the
    # identical self-copy structure and hit the identical bug.
    return 0
  fi
  install -m 0755 "$0" /usr/local/sbin/privos-restrict-sandbox-plane.sh
  cat > /etc/systemd/system/privos-restrict-sandbox-plane.service <<UNIT
[Unit]
Description=Restrict the PrivOS self-hosted sandbox plane to loopback and agent VM egress to private ranges
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment="VM_EGRESS_MODE=${VM_EGRESS_MODE:-open}"
ExecStart=/usr/local/sbin/privos-restrict-sandbox-plane.sh "${protected_ports}" "${egress_allowlist}"

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable privos-restrict-sandbox-plane.service >/dev/null 2>&1 || true

  run_iptables -L DOCKER-USER -n --line-numbers | tail -n +3
}

# A helper container (privos-netguard, compose.desktop.yml) cannot know which
# iptables backend the Docker daemon on its host uses; pick the one whose
# DOCKER-USER chain exists. Falls back to plain `iptables` when neither has it
# yet (the daemon creates the chain at its first container start).
select_iptables_backend() {
  local b
  [[ -n "${PRIVOS_IPTABLES:-}" ]] && return 0
  for b in iptables-nft iptables-legacy; do
    if command -v "$b" >/dev/null 2>&1 && "$b" -S DOCKER-USER >/dev/null 2>&1; then
      PRIVOS_IPTABLES="$b"
      return 0
    fi
  done
  PRIVOS_IPTABLES="iptables"
}

# True when this script's rules are live: the sandbox-plane DROPs, plus the
# agent-VM egress rules once the agent bridge exists.
rules_present() {
  local rules
  rules="$(run_iptables -S DOCKER-USER 2>/dev/null)" || return 1
  grep -q -- "--comment $SANDBOX_PLANE_TAG" <<< "$rules" || return 1
  run_ip link show "$VM_BRIDGE_IFACE" >/dev/null 2>&1 || return 0
  grep -q -- "--comment $VM_EGRESS_TAG" <<< "$rules"
}

# `--loop`: the Docker Desktop form (privos-netguard, compose.desktop.yml). There
# is no systemd unit inside the Desktop VM, and the daemon recreates DOCKER-USER
# empty whenever Docker Desktop restarts, so apply now and re-apply every
# PRIVOS_NETGUARD_INTERVAL seconds (default 60) whenever the tagged rules are
# missing. Stopping the container deliberately leaves the rules in place: agent
# containers are started by sandbox-proxy outside compose and can outlive a
# `compose down`, so their egress must stay restricted. `--clear` (run by the
# installers' `--uninstall --purge`) is the only way the rules are removed.
loop_rules() {
  local protected_ports="$1" egress_allowlist="$2"
  select_iptables_backend
  echo "netguard: using ${PRIVOS_IPTABLES}"
  trap 'echo "netguard: stopping, rules left in place"; exit 0' TERM INT
  while :; do
    if ! rules_present; then
      apply_sandbox_plane_rules "$protected_ports"
      apply_vm_egress_rules "$egress_allowlist"
      echo "netguard: rules applied"
    fi
    sleep "${PRIVOS_NETGUARD_INTERVAL:-60}" &
    wait $! || true
  done
}

main() {
  # `--clear`: remove every rule this script ever adds (both tags) and stop
  # — used by install.sh's `--uninstall --purge` so the (now-live, see
  # apply_sandbox_plane_rules) DROPs never outlive the install they came
  # from. Deliberately does not touch the persisted unit/script files;
  # install.sh's do_uninstall removes those itself after this returns.
  # `--present`: exit 0 only when the rules are live — privos-netguard's
  # healthcheck, which sandbox-proxy (the only service that starts agent
  # containers) waits for on Docker Desktop.
  if [[ "${1:-}" == "--present" ]]; then
    [[ -n "${PRIVOS_NETGUARD:-}" ]] && select_iptables_backend
    rules_present
    return
  fi
  # `--check`: validate the arguments and VM_EGRESS_MODE without touching any
  # rule — the Docker Desktop installers run it before `compose up` so a typo
  # aborts the install exactly as it does on Linux.
  if [[ "${1:-}" == "--check" ]]; then
    validate_egress_allowlist "${3:-}"
    validate_vm_egress_mode
    return 0
  fi
  if [[ "${1:-}" == "--clear" ]]; then
    [[ -n "${PRIVOS_NETGUARD:-}" ]] && select_iptables_backend
    clear_tagged_rules "$SANDBOX_PLANE_TAG"
    clear_tagged_rules "$VM_EGRESS_TAG"
    return 0
  fi

  local loop="false"
  if [[ "${1:-}" == "--loop" ]]; then
    loop="true"
    shift
  fi

  local protected_ports="${1:?comma-separated protected ports/ranges required, e.g. 8556,8557,9000,30000:30999}"
  local egress_allowlist="${2:-}"

  # Validate BEFORE touching a single rule — see validate_egress_allowlist's
  # own comment for why a bad entry must abort here and not partway through
  # either apply_* function.
  validate_egress_allowlist "$egress_allowlist"
  validate_vm_egress_mode

  if [[ "$loop" == "true" ]]; then
    loop_rules "$protected_ports" "$egress_allowlist"
    return 0
  fi

  apply_sandbox_plane_rules "$protected_ports"
  apply_vm_egress_rules "$egress_allowlist"
  persist_rules "$protected_ports" "$egress_allowlist"
}

# Run main unless the file is being *sourced* (tests/ source it to exercise
# individual functions against a mocked run_iptables/run_ip). Same guard
# install.sh uses, for the same reason.
if ! (return 0 2>/dev/null); then
  main "$@"
fi
