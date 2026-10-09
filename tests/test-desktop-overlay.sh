#!/usr/bin/env bash
# Renders compose.yml + compose.desktop.yml with a fixture .env and asserts the
# Docker Desktop contract: no host data bind survives, the Mongo keyfile comes
# from the privos-init volume, every data service waits for privos-init,
# netguard runs with host networking and NET_ADMIN, and the sandbox pool / MCP
# broker paths are the daemon-side mountpoints of their volumes.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SELF_DIR/helpers.sh"
cd "$SELF_DIR/.." || exit 1

if ! docker compose version >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  echo "SKIP - docker compose or jq not available; compose.desktop.yml rendering not checked"
  exit 0
fi

cfg="$(docker compose -f compose.yml -f compose.desktop.yml --env-file tests/fixtures/desktop-env.txt \
  --profile knowledge-vector --profile app-cluster config --format json 2>&1)"
rc=$?
assert_status 0 "$rc" "compose.yml + compose.desktop.yml render"
[[ "$rc" -eq 0 ]] || { echo "$cfg" >&2; report_and_exit; exit; }

q() { jq -r "$1" <<< "$cfg"; }

assert_eq "" "$(q '[.services[] | select(.image | test("privos-netguard") | not) | .volumes[]? | select(.type=="bind") | .source | select(startswith("/Users/tester/.privos/data"))] | join(",")')" \
  "no service binds a host data directory"
assert_eq "/Users/tester/.privos/secrets/mongo-keyfile" "$(q '.services["privos-init"].volumes[] | select(.target=="/src/mongo-keyfile") | .source')" \
  "privos-init reads the keyfile from the install dir"
assert_eq "mongo-keyfile" "$(q '.services.mongo.volumes[] | select(.target=="/run/secrets") | .source')" \
  "mongo reads the keyfile from the mongo-keyfile volume"
assert_eq "" "$(q '.services.mongo.volumes[] | select(.type=="bind") | .source')" "mongo has no host bind left"

for svc in mongo rustfs hub sandbox-board sandbox-proxy weaviate app-cluster; do
  assert_eq "service_completed_successfully" "$(q ".services[\"$svc\"].depends_on[\"privos-init\"].condition")" \
    "$svc waits for privos-init"
done

assert_eq "host" "$(q '.services["privos-netguard"].network_mode')" "netguard uses host networking"
assert_contains "$(q '.services["privos-netguard"].cap_add | join(",")')" "NET_ADMIN" "netguard has NET_ADMIN"
assert_eq "--loop|8556,8557,9000,30000-30999|10.20.0.0/16" "$(q '.services["privos-netguard"].command | join("|")')" \
  "netguard applies the same ports and allowlist as the Linux installer"

pool="/var/lib/docker/volumes/privos-sandbox-pool/_data"
for svc in sandbox-board sandbox-proxy; do
  assert_eq "$pool" "$(q ".services[\"$svc\"].environment.POOL_DATA_BASE")" "$svc POOL_DATA_BASE is the daemon mountpoint"
  assert_eq "$pool" "$(q ".services[\"$svc\"].volumes[] | select(.source==\"sandbox-pool\") | .target")" "$svc mounts the pool volume at that path"
  assert_eq "self-hosted|true" "$(q ".services[\"$svc\"].volumes[] | select(.target==\"/var/lib/privos/self-hosted\") | \"\(.volume.subpath)|\(.read_only)\"")" \
    "$svc sees only hub-lib/self-hosted, read-only"
done
assert_eq "/var/lib/docker/volumes/privos-mcp-broker/_data" "$(q '.services["app-cluster"].environment.MCP_BROKER_ROOT')" \
  "app-cluster MCP_BROKER_ROOT is the daemon mountpoint"
assert_eq "privos-sandbox-pool" "$(q '.volumes["sandbox-pool"].name')" "volume names carry the project prefix"
assert_eq "0.0.0.0" "$(q '.services.hub.ports[] | select(.target==3000) | .host_ip')" \
  "hub stays published on 0.0.0.0 (same as Linux)"

report_and_exit
