#!/usr/bin/env bash
# Runs ON the self-hosted install host. Locks the sandbox plane (board,
# proxy, MinIO, VM pool range) to loopback-only at the DOCKER-USER level, as
# a backstop against a LATER `ports:` edit in compose.yml republishing one of
# them on 0.0.0.0 — the compose.yml bind (127.0.0.1:PORT:PORT) is the primary
# control; this is defense-in-depth so a manual edit mistake alone cannot
# expose the sandbox plane off-host.
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

protected_ports="${1:?comma-separated protected ports/ranges required, e.g. 8556,8557,9000,30000:30999}"

apply() {
  # Start clean so re-running (install.sh re-run / --upgrade) never stacks
  # duplicates.
  while read -r rule; do
    # shellcheck disable=SC2086 # the -S output is re-fed as iptables arguments
    iptables -D DOCKER-USER ${rule#-A DOCKER-USER } 2>/dev/null || true
  done < <(iptables -S DOCKER-USER 2>/dev/null | grep -- '--comment "privos-self-hosted-sandbox-plane"')

  IFS=',' read -ra ports <<< "$protected_ports"
  for p in "${ports[@]}"; do
    port_range="${p/:/-}"
    iptables -I DOCKER-USER 1 -p tcp -s 127.0.0.1/8 -m conntrack --ctorigdstport "$port_range" \
      -m comment --comment "privos-self-hosted-sandbox-plane" -j RETURN
    iptables -A DOCKER-USER -p tcp -m conntrack --ctstate NEW --ctorigdstport "$port_range" \
      -m comment --comment "privos-self-hosted-sandbox-plane" -j DROP
  done
}

apply

# iptables rules do not survive a reboot, and Docker recreates DOCKER-USER
# empty when it restarts, so reapply on boot and after docker.
#
# Piping this script over stdin leaves $0 as "bash", so the rules apply but
# the unit cannot be installed. Say so loudly instead of failing with an
# obscure `install: cannot stat 'bash'` after the rules are already live.
if [[ ! -r "$0" || "$0" == bash || "$0" == sh ]]; then
  echo "WARNING: rules applied but NOT made persistent — install.sh copies this script to disk before running it; if you invoked it manually over a pipe, copy it to a file and run it from there to install the boot unit" >&2
  iptables -L DOCKER-USER -n --line-numbers | tail -n +3
  exit 0
fi
install -m 0755 "$0" /usr/local/sbin/privos-restrict-sandbox-plane.sh
cat > /etc/systemd/system/privos-restrict-sandbox-plane.service <<UNIT
[Unit]
Description=Restrict the PrivOS self-hosted sandbox plane to loopback
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/privos-restrict-sandbox-plane.sh ${protected_ports}

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable privos-restrict-sandbox-plane.service >/dev/null 2>&1 || true

iptables -L DOCKER-USER -n --line-numbers | tail -n +3
