#!/usr/bin/env bash
# Unit tests for the App Cluster sidecar: finalize_sidecar_config's
# app-cluster profile wiring, and the driver-removal guard
# (check_local_runtime_installations) that refuses to strand an existing
# local-runtime installation when local-runtime-driver leaves the bundle.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SELF_DIR/helpers.sh"
# shellcheck source=/dev/null
source "$SELF_DIR/../install.sh"
set +e

if ! command -v jq >/dev/null 2>&1; then
  echo "# SKIP: jq not installed"
  exit 0
fi

# shellcheck disable=SC2034 # PRIVOS_WITH_KNOWLEDGE_VECTOR/PRIVOS_WITH_APP_CLUSTER/PRIVOS_DOCKER_SOCKET_GID/ASSUME_YES are read indirectly by finalize_sidecar_config() in the sourced install.sh
reset_sidecar_state() {
  PRIVOS_WITH_KNOWLEDGE_VECTOR="false"
  PRIVOS_WITH_APP_CLUSTER="false"
  PRIVOS_DOCKER_SOCKET_GID=""
  COMPOSE_PROFILES=""
  ASSUME_YES="true" # avoid any accidental interactive prompt inside a subshell
}

# --- finalize_sidecar_config: app-cluster enabled + gid already known ------

reset_sidecar_state
# shellcheck disable=SC2034 # read by finalize_sidecar_config() in the sourced install.sh
PRIVOS_WITH_APP_CLUSTER="true"
# shellcheck disable=SC2034 # read by finalize_sidecar_config() in the sourced install.sh
PRIVOS_DOCKER_SOCKET_GID="999"
finalize_sidecar_config
assert_eq "app-cluster" "$COMPOSE_PROFILES" "finalize_sidecar_config: app-cluster alone yields COMPOSE_PROFILES=app-cluster"

# --- finalize_sidecar_config: both sidecars enabled -------------------------

reset_sidecar_state
# shellcheck disable=SC2034 # read by finalize_sidecar_config() in the sourced install.sh
PRIVOS_WITH_KNOWLEDGE_VECTOR="true"
PRIVOS_WITH_APP_CLUSTER="true"
PRIVOS_DOCKER_SOCKET_GID="999"
finalize_sidecar_config
assert_eq "knowledge-vector,app-cluster" "$COMPOSE_PROFILES" "finalize_sidecar_config: knowledge-vector + app-cluster combine in declared order"

# --- finalize_sidecar_config: app-cluster disabled --------------------------

reset_sidecar_state
PRIVOS_WITH_APP_CLUSTER="false"
finalize_sidecar_config
assert_eq "" "$COMPOSE_PROFILES" "finalize_sidecar_config: no profiles when every sidecar is disabled"
assert_not_contains "$COMPOSE_PROFILES" "app-cluster" "finalize_sidecar_config: app-cluster profile absent when opted out"

# --- finalize_sidecar_config: enabled but no resolvable docker-socket gid --

reset_sidecar_state
# shellcheck disable=SC2034 # read by finalize_sidecar_config() in the sourced install.sh
PRIVOS_WITH_APP_CLUSTER="true"
# shellcheck disable=SC2034 # read by finalize_sidecar_config() in the sourced install.sh
PRIVOS_DOCKER_SOCKET_GID=""
# shellcheck disable=SC2329 # invoked indirectly by finalize_sidecar_config() in the sourced install.sh
stat() { return 1; } # force "docker.sock not present" regardless of this host's real socket
( finalize_sidecar_config ) >/dev/null 2>&1
assert_status 1 "$?" "finalize_sidecar_config: dies when app-cluster is enabled but the docker socket gid cannot be resolved"
unset -f stat

# --- check_local_runtime_installations: fresh install never queries mongo --

# shellcheck disable=SC2034 # read by check_local_runtime_installations() in the sourced install.sh
HAD_EXISTING_ENV="false"
# shellcheck disable=SC2329 # invoked indirectly by check_local_runtime_installations() if it (incorrectly) queries mongo
guard_local_runtime_installations() { echo "SHOULD NOT BE CALLED ON A FRESH INSTALL" >&2; return 1; }
( check_local_runtime_installations ) >/dev/null 2>&1
assert_status 0 "$?" "check_local_runtime_installations: no-ops on a fresh install (HAD_EXISTING_ENV=false)"

# --- check_local_runtime_installations: existing install, nothing bound ----

# shellcheck disable=SC2034 # read by check_local_runtime_installations() in the sourced install.sh
HAD_EXISTING_ENV="true"
# shellcheck disable=SC2329 # invoked indirectly by check_local_runtime_installations() in the sourced install.sh
guard_local_runtime_installations() { echo "[]"; }
( check_local_runtime_installations ) >/dev/null 2>&1
assert_status 0 "$?" "check_local_runtime_installations: passes when no installation is bound to a non-tunnel cluster"

# --- check_local_runtime_installations: bound installation refuses ---------

# shellcheck disable=SC2329 # invoked indirectly by check_local_runtime_installations() in the sourced install.sh
guard_local_runtime_installations() { echo '[{"_id":"abc123","name":"legacy-local-app"}]'; }
out="$( check_local_runtime_installations 2>&1 )"
rc=$?
assert_status 1 "$rc" "check_local_runtime_installations: refuses (non-zero exit) when an installation is still bound"
assert_contains "$out" "legacy-local-app" "check_local_runtime_installations: names the bound installation"
assert_contains "$out" "uninstall the app" "check_local_runtime_installations: instructs the operator to uninstall first"

# --- check_local_runtime_installations: mongosh banner noise before JSON ---

# shellcheck disable=SC2329 # invoked indirectly by check_local_runtime_installations() in the sourced install.sh
guard_local_runtime_installations() { printf 'Current Mongosh Log ID: deadbeef\nConnecting to: mongodb://mongo:27017\n[]\n'; }
( check_local_runtime_installations ) >/dev/null 2>&1
assert_status 0 "$?" "check_local_runtime_installations: tolerates mongosh banner lines before the JSON output"

# --- check_local_runtime_installations: query failure fails CLOSED ---------

# shellcheck disable=SC2329 # invoked indirectly by check_local_runtime_installations() in the sourced install.sh
guard_local_runtime_installations() { echo "connection refused" >&2; return 1; }
( check_local_runtime_installations ) >/dev/null 2>&1
assert_status 1 "$?" "check_local_runtime_installations: fails closed when the mongo query itself errors"

# --- check_local_runtime_installations: unparseable output fails CLOSED ----

# shellcheck disable=SC2329 # invoked indirectly by check_local_runtime_installations() in the sourced install.sh
guard_local_runtime_installations() { echo "not json at all"; }
( check_local_runtime_installations ) >/dev/null 2>&1
assert_status 1 "$?" "check_local_runtime_installations: fails closed when the query output cannot be parsed"

# --- The bootstrap seed must reach BOTH ends ----------------------------------
# Community pairing is a mutual HMAC challenge over the compose network. When the
# hub is missing the seed it answers `not_configured` forever and the bundled App
# Cluster never pairs, with its healthcheck still green. Worse, the hub burns the
# one-shot seed before replying, so a half-wired stack cannot be repaired by a
# restart. Assert the variable is wired into both services.
compose_service_block() { # <service>
  awk -v svc="  $1:" '$0 == svc {inside=1; next} /^  [a-z][a-z0-9-]*:$/ {inside=0} inside {print}' "$SELF_DIR/../compose.yml"
}
hub_block="$(compose_service_block hub)"
cluster_block="$(compose_service_block app-cluster)"
assert_contains "$hub_block" "PRIVOS_APP_CLUSTER_BOOTSTRAP_TOKEN" "compose: the hub receives the community bootstrap seed"
assert_contains "$cluster_block" "PRIVOS_APP_CLUSTER_BOOTSTRAP_TOKEN" "compose: the App Cluster receives the community bootstrap seed"

report_and_exit
