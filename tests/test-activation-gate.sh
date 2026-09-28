#!/usr/bin/env bash
# Unit tests for the CE mandatory-activation gate wiring this bundle owns:
# compose.yml mounts the hub's self-hosted/ directory read-only into
# sandbox-board and sandbox-proxy with PRIVOS_SELF_HOSTED_LLM_ENV_PATH set on
# both (the sandbox re-reads llm.env by mtime, no restart needed after
# activation), and install.sh's printed summary states activation is
# required and is a free registration, not a paid licence.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SELF_DIR/helpers.sh"
# shellcheck source=/dev/null
source "$SELF_DIR/../install.sh"
set +e

COMPOSE_FILE_PATH="$SELF_DIR/../compose.yml"

# Prints the lines of a top-level compose service block (from its "  name:"
# header up to, but excluding, the next top-level "  other-name:" line).
service_block() {
  local name="$1"
  awk -v svc="  ${name}:" '
    $0 == svc { found=1; print; next }
    found && /^  [A-Za-z0-9_-]+:$/ { exit }
    found { print }
  ' "$COMPOSE_FILE_PATH"
}

# --- compose.yml: sandbox-board mounts self-hosted/ read-only + env path ---

board_block="$(service_block sandbox-board)"
assert_contains "$board_block" \
  '${PRIVOS_DIR}/data/hub-lib/self-hosted:/var/lib/privos/self-hosted:ro' \
  "compose.yml sandbox-board: mounts hub-lib/self-hosted read-only"
assert_contains "$board_block" \
  'PRIVOS_SELF_HOSTED_LLM_ENV_PATH: /var/lib/privos/self-hosted/llm.env' \
  "compose.yml sandbox-board: sets PRIVOS_SELF_HOSTED_LLM_ENV_PATH"

# --- compose.yml: sandbox-proxy mounts self-hosted/ read-only + env path ---

proxy_block="$(service_block sandbox-proxy)"
assert_contains "$proxy_block" \
  '${PRIVOS_DIR}/data/hub-lib/self-hosted:/var/lib/privos/self-hosted:ro' \
  "compose.yml sandbox-proxy: mounts hub-lib/self-hosted read-only"
assert_contains "$proxy_block" \
  'PRIVOS_SELF_HOSTED_LLM_ENV_PATH: /var/lib/privos/self-hosted/llm.env' \
  "compose.yml sandbox-proxy: sets PRIVOS_SELF_HOSTED_LLM_ENV_PATH"

# --- compose.yml: the RO mount never widens onto the hub's own identity ---
# (only the self-hosted/ subdir is shared; hub-lib's parent, holding the hub
# identity keypair, is never bind-mounted into board or proxy).

assert_not_contains "$board_block" '${PRIVOS_DIR}/data/hub-lib:/var/lib/privos' \
  "compose.yml sandbox-board: never mounts the whole hub-lib dir (identity keypair)"
assert_not_contains "$proxy_block" '${PRIVOS_DIR}/data/hub-lib:/var/lib/privos' \
  "compose.yml sandbox-proxy: never mounts the whole hub-lib dir (identity keypair)"

# --- install.sh: pre-creates hub-lib/self-hosted before any container starts

main_src="$(declare -f main)"
assert_contains "$main_src" 'mkdir -p "$PRIVOS_DIR/data/hub-lib/self-hosted"' \
  "install.sh main: pre-creates hub-lib/self-hosted (avoids the root auto-mkdir race)"
assert_contains "$main_src" 'chown 1001:1001 "$PRIVOS_DIR/data/hub-lib/self-hosted"' \
  "install.sh main: hub-lib/self-hosted is owned by uid 1001 (same as hub)"

# --- install.sh: the printed summary states activation is required --------

summary_src="$(declare -f print_summary)"
assert_contains "$summary_src" "REQUIRED" \
  "print_summary: states activation is REQUIRED"
assert_contains "$summary_src" "not a paid" \
  "print_summary: clarifies this is not a paid licence"
assert_contains "$summary_src" "free registration" \
  "print_summary: calls it a free registration"
assert_contains "$summary_src" "client.privos.io/self-hosted/activate" \
  "print_summary: prints the activation link"

interactive_src="$(declare -f interactive_activation)"
assert_contains "$interactive_src" "REQUIRED" \
  "interactive_activation: states activation is REQUIRED"
assert_contains "$interactive_src" "not a paid licence" \
  "interactive_activation: clarifies this is not a paid licence"
assert_contains "$interactive_src" "client.privos.io/self-hosted/activate" \
  "interactive_activation: prints the activation link"
assert_contains "$interactive_src" "Ctrl-C to skip" \
  "interactive_activation: the interactive wait stays optional (Ctrl-C skips)"

report_and_exit
