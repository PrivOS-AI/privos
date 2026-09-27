#!/usr/bin/env bash
# Runs ON the self-hosted install host. Locks the sandbox plane (board,
# proxy, RustFS, VM pool range) to loopback-only at the DOCKER-USER level, as
# a backstop against a LATER `ports:` edit in compose.yml republishing one of
# them on 0.0.0.0 — the compose.yml bind (127.0.0.1:PORT:PORT) is the primary
# control; this is defense-in-depth so a manual edit mistake alone cannot
# expose the sandbox plane off-host. It also restricts EGRESS from agent VM
# containers to private/link-local/carrier-grade-NAT destinations and the
# host itself, so a prompt-injected agent's Bash tool (which has no in-process
# SSRF guard of its own — see packages/agentic-sdk in privos-sandbox) cannot
# reach the operator's LAN, cloud metadata, or the sandbox's own data-plane
# services by opening a raw TCP connection.
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
# source IPs), the sandbox plane has exactly one legitimate source: the host
# itself. NEW connections are allowed only from 127.0.0.1/8; everything else
# is dropped for the protected ports.
set -euo pipefail

SANDBOX_PLANE_TAG="privos-self-hosted-sandbox-plane"
VM_EGRESS_TAG="privos-self-hosted-vm-egress"

# Thin indirection over the two external commands this script shells out to,
# purely so tests/test-docker-user-rules.sh can override them and assert on
# the exact invocations made without mutating a real host firewall (same
# reason tests/test-port-check.sh overrides run_ss/run_lsof instead of
# calling `ss`/`lsof` for real).
run_iptables() { iptables "$@"; }
run_ip() { ip "$@"; }

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
    # first time it ever touches this chain, so that an operator with no
    # custom rules is unaffected. `-A` (append) ALWAYS lands after that rule,
    # which makes an appended DROP unreachable — every packet hits Docker's
    # catch-all RETURN and leaves the chain first. `-I DOCKER-USER 1` (insert
    # at the top) is the only placement that actually executes. Insert the
    # DROP first, then the RETURN: the RETURN's later `-I 1` pushes the DROP
    # down by exactly one slot, so for THIS port the RETURN is checked before
    # the DROP, and both sit above Docker's own rule. (This one-line ordering
    # bug meant the DROP rules below had never actually executed — confirmed
    # live: a non-loopback probe against a bare DOCKER-USER chain with only
    # the old `-A`'d DROP present was not, in fact, dropped.)
    run_iptables -I DOCKER-USER 1 -p tcp -m conntrack --ctstate NEW --ctorigdstport "$port_range" \
      -m comment --comment "$SANDBOX_PLANE_TAG" -j DROP
    run_iptables -I DOCKER-USER 1 -p tcp -s 127.0.0.1/8 -m conntrack --ctorigdstport "$port_range" \
      -m comment --comment "$SANDBOX_PLANE_TAG" -j RETURN
  done
}

# Agent VM containers are spawned by sandbox-proxy directly via the Docker
# API (not through compose) and, in the shipped default configuration
# (VM_NETWORK left unset — see compose.yml's sandbox-proxy service and
# RENDERER-DIFF.md), land on Docker's DEFAULT bridge network — interface
# docker0 — rather than the named `privos` network the rest of the stack
# (hub, mongo, redis, rustfs, board, proxy) runs on. That split is what makes
# `-i docker0` the right match for "traffic from an agent VM container" here:
# nothing else in a stock install attaches to the default bridge, because
# every compose service is pinned to the named network instead. The
# alternative — giving agent VM containers their OWN dedicated bridge —
# needs a sandbox-proxy code change (setting VM_NETWORK to a network that is
# neither the default bridge nor the data-plane network `privos` itself,
# since putting VMs on `privos` would reopen direct VM->Mongo/Redis/RustFS
# access) and is out of scope for a firewall-only fix. `-i docker0` works
# with the compose.yml and sandbox-proxy code shipped today and requires
# changing neither.
apply_vm_egress_rules() {
  local egress_allowlist="$1" host_callback_ports="$2"
  clear_tagged_rules "$VM_EGRESS_TAG"

  if ! run_ip link show docker0 >/dev/null 2>&1; then
    echo "WARNING: no docker0 interface found — skipping agent VM egress rules (Docker creates it lazily; re-run this script, or install.sh, after the sandbox stack has spawned at least one agent VM)" >&2
    return 0
  fi

  # RFC1918 + carrier-grade NAT (100.64.0.0/10) + link-local (169.254.0.0/16,
  # which covers the 169.254.169.254 cloud-metadata address on every major
  # cloud) + loopback. Anything NOT in one of these ranges — the public
  # internet, including the LLM gateway agents call — is left untouched:
  # Docker's own catch-all RETURN (see the comment in apply_sandbox_plane_rules
  # above) lets it through once these DROPs don't match.
  #
  # Same top-first insertion reasoning as apply_sandbox_plane_rules: every
  # rule below is added via `-I DOCKER-USER 1`, never `-A`, or it would land
  # after — and be shadowed by — Docker's own unconditional RETURN.
  for dest in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8; do
    run_iptables -I DOCKER-USER 1 -i docker0 -d "$dest" -p tcp -m conntrack --ctstate NEW \
      -m comment --comment "$VM_EGRESS_TAG" -j DROP
  done

  # The one destination agent VM containers are known to need directly
  # outside the ranges just blocked: the hub, published on all interfaces,
  # reached via the docker0 bridge's own (host-side) address. Every OTHER
  # sandbox-plane service — board, proxy, RustFS, Mongo, Redis — is either
  # loopback-only (refused at the socket already; not a firewall concern) or
  # lives on the separate `privos` network agent VM containers are not
  # attached to (Docker's inter-bridge isolation already keeps that path
  # closed, independent of anything in this file — confirmed empirically,
  # network-and-egress-verification, 2026-09-27). NOTE: in the exact shipped
  # configuration this script ships with (VM_NETWORK unset, SANDBOX_PROXY_URL
  # set to the Docker-DNS form `http://sandbox-proxy:8557`), an agent VM
  # container cannot actually resolve or reach sandbox-proxy at all today —
  # that is a pre-existing connectivity gap independent of this firewall
  # script (see compose.yml's own comment on presigned RustFS URLs not
  # reaching VM containers), not something opened or closed by this rule.
  local docker0_addr
  docker0_addr="$(run_ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)"
  if [[ -n "$docker0_addr" ]]; then
    IFS=',' read -ra callback_ports <<< "$host_callback_ports"
    for cb_port in "${callback_ports[@]}"; do
      [[ -z "$cb_port" ]] && continue
      run_iptables -I DOCKER-USER 1 -i docker0 -d "$docker0_addr" -p tcp --dport "$cb_port" \
        -m comment --comment "$VM_EGRESS_TAG" -j RETURN
    done
  else
    echo "WARNING: could not determine docker0's address — the hub host-callback allowance was not added; agent VM containers may lose hub connectivity until this script is re-run" >&2
  fi

  # Operator allowlist last, so these RETURNs end up checked FIRST (every
  # insertion here uses -I 1; whatever is inserted last ends up on top).
  IFS=',' read -ra allow_entries <<< "$egress_allowlist"
  for entry in "${allow_entries[@]}"; do
    entry="${entry#"${entry%%[![:space:]]*}"}" # ltrim
    entry="${entry%"${entry##*[![:space:]]}"}" # rtrim
    [[ -z "$entry" ]] && continue
    if [[ "$entry" != *.*.*.* ]]; then
      # Not IPv4-CIDR/IP-shaped (this firewall layer is IPv4-only, matching
      # the rest of this script) — a hostname or IPv6 entry, meaningful only
      # to the in-process guard, not to iptables.
      echo "WARNING: PRIVOS_EGRESS_ALLOWLIST entry '$entry' is not an IPv4 address/CIDR — the host firewall cannot match it and will ignore it here (the in-process WebFetch guard still honors it)" >&2
      continue
    fi
    run_iptables -I DOCKER-USER 1 -i docker0 -d "$entry" \
      -m comment --comment "$VM_EGRESS_TAG" -j RETURN
  done
}

# iptables rules do not survive a reboot, and Docker recreates DOCKER-USER
# empty when it restarts, so reapply on boot and after docker. Installs a
# oneshot systemd unit that re-invokes this same script with the same
# arguments; a no-op (with a loud warning) on a host with no systemd, or when
# this script was piped over stdin rather than run from a real file.
persist_rules() {
  local protected_ports="$1" egress_allowlist="$2" host_callback_ports="$3"

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
  install -m 0755 "$0" /usr/local/sbin/privos-restrict-sandbox-plane.sh
  cat > /etc/systemd/system/privos-restrict-sandbox-plane.service <<UNIT
[Unit]
Description=Restrict the PrivOS self-hosted sandbox plane to loopback and agent VM egress to private ranges
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/privos-restrict-sandbox-plane.sh "${protected_ports}" "${egress_allowlist}" "${host_callback_ports}"

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable privos-restrict-sandbox-plane.service >/dev/null 2>&1 || true

  run_iptables -L DOCKER-USER -n --line-numbers | tail -n +3
}

main() {
  local protected_ports="${1:?comma-separated protected ports/ranges required, e.g. 8556,8557,9000,30000:30999}"
  # Comma-separated CIDRs an operator wants agent VM containers to reach
  # despite the private-range egress block below (e.g. an internal LAN
  # service the agent is meant to call). A bare IP is treated as a host
  # route. Hostname entries are silently ignored HERE — iptables matches
  # addresses, not names. The in-process WebFetch guard in privos-sandbox
  # (PRIVOS_EGRESS_ALLOWLIST, packages/agentic-sdk/src/lib/outbound-host-guard.ts)
  # reads the SAME env var and DOES accept hostnames; one operator setting
  # covers both layers as far as each layer is able to act on it.
  local egress_allowlist="${2:-}"
  # Host-side port(s) agent VM containers are known to need to reach
  # directly today: the hub, published on all interfaces (see the "host
  # callback" comment in apply_vm_egress_rules for why nothing else needs a
  # slot here). Comma-separated if ever more than one is needed.
  local host_callback_ports="${3:-3000}"

  apply_sandbox_plane_rules "$protected_ports"
  apply_vm_egress_rules "$egress_allowlist" "$host_callback_ports"
  persist_rules "$protected_ports" "$egress_allowlist" "$host_callback_ports"
}

# Run main unless the file is being *sourced* (tests/ source it to exercise
# individual functions against a mocked run_iptables/run_ip). Same guard
# install.sh uses, for the same reason.
if ! (return 0 2>/dev/null); then
  main "$@"
fi
