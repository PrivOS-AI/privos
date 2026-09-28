#!/usr/bin/env bash
# Unit tests for the CE mandatory-activation gate wiring this bundle owns:
# compose.yml mounts ONLY the hub's self-hosted/ directory read-only into
# sandbox-board and sandbox-proxy with PRIVOS_SELF_HOSTED_LLM_ENV_PATH set on
# both (the sandbox re-reads llm.env by mtime, no restart needed after
# activation); install.sh pre-creates that directory — refusing a symlink —
# before the stack ever comes up; and the printed summary/interactive wait
# state activation is required, a free registration, and reflect what the
# hub's local status file actually says.
# The literal-text assertions grep for `${VAR}` text in compose.yml/install.sh,
# so single-quoted patterns are intentional.
# shellcheck disable=SC2016
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

# Prints only the "    volumes:" sub-list of a service block (from that
# 4-space-indented header up to, but excluding, the next 4-space-indented
# sibling key) — narrower than the whole service block, so a mutation that
# adds a SECOND mount next to the expected one cannot hide next to some other
# key a plain substring search never looked at.
volumes_block() {
  awk '
    /^    volumes:$/ { found=1; print; next }
    found && /^    [A-Za-z0-9_-]+:/ { exit }
    found { print }
  ' <<<"$1"
}

# Structural check: exactly one line in the service's volumes: list mentions
# hub-lib at all, and that one line is precisely the read-only self-hosted/
# subdir mount — catches both an ADDED second hub-lib mount (e.g. a writable
# whole-directory bind) and the expected mount being widened or losing :ro,
# neither of which a plain "does this exact other string appear" check (the
# previous version of this file) would notice.
assert_single_readonly_self_hosted_mount() {
  local volumes="$1" label="$2" hub_lib_line_count
  # Only actual YAML sequence items ("  - ..."), never a comment line — a
  # multi-line comment explaining the mount also says "hub-lib" more than
  # once, which would otherwise make this check fail on unmodified input.
  hub_lib_line_count="$(grep -E '^ *- ' <<<"$volumes" | grep -c 'hub-lib')"
  assert_eq "1" "$hub_lib_line_count" \
    "$label: exactly one hub-lib-related line in volumes:"
  assert_contains "$volumes" \
    '- ${PRIVOS_DIR}/data/hub-lib/self-hosted:/var/lib/privos/self-hosted:ro' \
    "$label: that one line is the read-only self-hosted/ subdir mount"
}

# --- compose.yml: sandbox-board mounts self-hosted/ read-only + env path ---

board_block="$(service_block sandbox-board)"
board_volumes="$(volumes_block "$board_block")"
assert_single_readonly_self_hosted_mount "$board_volumes" "compose.yml sandbox-board"
assert_contains "$board_block" \
  'PRIVOS_SELF_HOSTED_LLM_ENV_PATH: /var/lib/privos/self-hosted/llm.env' \
  "compose.yml sandbox-board: sets PRIVOS_SELF_HOSTED_LLM_ENV_PATH"

# --- compose.yml: sandbox-proxy mounts self-hosted/ read-only + env path ---

proxy_block="$(service_block sandbox-proxy)"
proxy_volumes="$(volumes_block "$proxy_block")"
assert_single_readonly_self_hosted_mount "$proxy_volumes" "compose.yml sandbox-proxy"
assert_contains "$proxy_block" \
  'PRIVOS_SELF_HOSTED_LLM_ENV_PATH: /var/lib/privos/self-hosted/llm.env' \
  "compose.yml sandbox-proxy: sets PRIVOS_SELF_HOSTED_LLM_ENV_PATH"

# --- install.sh: pre-creates hub-lib/self-hosted, refusing a symlink, ------
# --- before any container starts ------------------------------------------

main_src="$(declare -f main)"
assert_contains "$main_src" 'refuse_symlink "$PRIVOS_DIR/data/hub-lib/self-hosted"' \
  "install.sh main: refuses a symlinked hub-lib/self-hosted before touching it"
assert_contains "$main_src" 'mkdir -p "$PRIVOS_DIR/data/hub-lib/self-hosted"' \
  "install.sh main: pre-creates hub-lib/self-hosted (avoids the root auto-mkdir race)"
assert_contains "$main_src" 'chown -h 1001:1001 "$PRIVOS_DIR/data/hub-lib/self-hosted"' \
  "install.sh main: hub-lib/self-hosted is owned by uid 1001 (same as hub), chown never follows a symlink"
assert_contains "$main_src" 'chmod 0700 "$PRIVOS_DIR/data/hub-lib/self-hosted"' \
  "install.sh main: hub-lib/self-hosted is 0700 — private to the hub"
assert_contains "$main_src" 'refuse_symlink "$PRIVOS_DIR/data/hub-marketplace/apps"' \
  "install.sh main: refuses a symlinked hub-marketplace/apps before touching it"

# Ordering: the pre-create block must run BEFORE the stack comes up, or a
# fresh bind-mount path gets auto-created (root-owned) by `docker compose up`
# first, leaving the hub unable to write into its own directory. Compares
# line numbers within `declare -f main`'s own output — stable and specific
# to two commands each expected exactly once, so this does not depend on
# `main`'s exact formatting elsewhere.
first_line_of() { grep -n -F -- "$1" <<<"$2" | head -n1 | cut -d: -f1; }

mkdir_self_hosted_line="$(first_line_of 'mkdir -p "$PRIVOS_DIR/data/hub-lib/self-hosted"' "$main_src")"
bring_up_line="$(first_line_of 'bring_up_stack;' "$main_src")"
if [[ -n "$mkdir_self_hosted_line" && -n "$bring_up_line" ]]; then
  assert_eq "true" "$([[ "$mkdir_self_hosted_line" -lt "$bring_up_line" ]] && echo true || echo false)" \
    "install.sh main: hub-lib/self-hosted is pre-created before bring_up_stack (not raced by compose's own auto-mkdir)"
else
  assert_eq "found both markers" "mkdir_self_hosted_line=${mkdir_self_hosted_line:-<missing>} bring_up_line=${bring_up_line:-<missing>}" \
    "install.sh main: both ordering markers are present in main()"
fi

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

# --- print_summary: behavioural check of the three states -----------------
# Stubs read_request_code/read_license_status (both are plain functions,
# redefinable after sourcing install.sh) so print_summary runs for real, on
# each of the three states the hub's local files can be in, instead of only
# ever being inspected as text.

# shellcheck disable=SC2034 # read by print_summary/print_ready (sourced from install.sh), not directly in this file
PRIVOS_ROOT_URL="http://localhost:3000"
PRIVOS_DIR="/tmp/privos-test-activation-gate"
# shellcheck disable=SC2034
COMPOSE_FILE="$PRIVOS_DIR/compose.yml"
# shellcheck disable=SC2034
ENV_FILE="$PRIVOS_DIR/.env"

print_summary_for() {
  # Named stub_* (not status/code) — print_summary itself does
  # `local code status`, an unassigned `local` that bash leaves genuinely
  # unset (not just empty); reusing either name here would shadow the stub's
  # own value with that unset local by the time read_request_code/
  # read_license_status actually run, and set -u would then reject it.
  local stub_status_json="$1" stub_code="$2"
  # shellcheck disable=SC2317 # invoked indirectly via print_summary below
  read_request_code() { printf '%s' "$stub_code"; }
  # shellcheck disable=SC2317
  read_license_status() { printf '%s' "$stub_status_json"; }
  print_summary
}

issued_output="$(print_summary_for '{"status":"issued","ownerEmail":"a@b.com"}' 'PRV-ABCD-EFGH-JKMN')"
assert_contains "$issued_output" "Activation:     done" \
  "print_summary: an issued status prints the done line"
assert_not_contains "$issued_output" "Request code:" \
  "print_summary: an issued status does not also print a request code"

pending_output="$(print_summary_for '' 'PRV-ABCD-EFGH-JKMN')"
assert_contains "$pending_output" "REQUIRED" \
  "print_summary: a pending status (code available) states activation is REQUIRED"
assert_contains "$pending_output" "Request code:   PRV-ABCD-EFGH-JKMN" \
  "print_summary: a pending status (code available) prints the code"
assert_not_contains "$pending_output" "Activation:     done" \
  "print_summary: a pending status never prints the done line"

no_code_output="$(print_summary_for '' '')"
assert_contains "$no_code_output" "not yet available" \
  "print_summary: no code yet tells the operator to check again"
assert_not_contains "$no_code_output" "Activation:     done" \
  "print_summary: no code yet never prints the done line"

report_and_exit
