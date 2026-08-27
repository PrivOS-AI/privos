#!/usr/bin/env bash
# Unit tests for install.sh's .env rendering: write_env_file / load_existing_env
# round-trip, secret-value quoting, file mode, and invocation-env precedence
# over a persisted .env.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SELF_DIR/helpers.sh"
# shellcheck source=/dev/null
source "$SELF_DIR/../install.sh"
set +e

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- env_quote ---------------------------------------------------------------

assert_eq "'plain'" "$(env_quote "plain")" "env_quote: plain value"
assert_eq "'a'\\''b'" "$(env_quote "a'b")" "env_quote: escapes an embedded single quote"

# --- write_env_file: mode + round-trippable content -------------------------
# shellcheck disable=SC2034 # write_env_file reads these indirectly via ENV_KEYS

PRIVOS_DIR="$WORK"
ADMIN_PASS="s3cr3t-admin-pass"
MONGO_ROOT_PASSWORD="s3cr3t-mongo-pass"
PRIVOS_ROOT_URL="https://example.test"
PRIVOS_HUB_PORT="3000"
# shellcheck disable=SC2034 # write_env_file reads this indirectly via ENV_KEYS
COMPOSE_PROFILES="knowledge-vector"

write_env_file "$WORK/.env"

mode="$(stat -f '%Lp' "$WORK/.env" 2>/dev/null || stat -c '%a' "$WORK/.env" 2>/dev/null)"
assert_eq "600" "$mode" "write_env_file: file mode is 0600"

content="$(cat "$WORK/.env")"
assert_contains "$content" "ADMIN_PASS='s3cr3t-admin-pass'" "write_env_file: ADMIN_PASS written correctly"
assert_contains "$content" "PRIVOS_ROOT_URL='https://example.test'" "write_env_file: PRIVOS_ROOT_URL written correctly"
assert_contains "$content" "COMPOSE_PROFILES='knowledge-vector'" "write_env_file: COMPOSE_PROFILES written correctly"

# --- load_existing_env: round-trip -------------------------------------------

unset ADMIN_PASS MONGO_ROOT_PASSWORD PRIVOS_ROOT_URL PRIVOS_HUB_PORT COMPOSE_PROFILES
load_existing_env
assert_eq "s3cr3t-admin-pass" "${ADMIN_PASS:-}" "load_existing_env: restores ADMIN_PASS"
assert_eq "https://example.test" "${PRIVOS_ROOT_URL:-}" "load_existing_env: restores PRIVOS_ROOT_URL"
assert_eq "3000" "${PRIVOS_HUB_PORT:-}" "load_existing_env: restores PRIVOS_HUB_PORT"

# --- load_existing_env: invocation-time env wins over the persisted file ----

unset ADMIN_PASS
ADMIN_PASS="explicit-invocation-value"
load_existing_env
assert_eq "explicit-invocation-value" "$ADMIN_PASS" "load_existing_env: does not clobber an already-set variable"

# --- generate_secrets: idempotent re-run keeps existing values --------------

unset ADMIN_PASS MONGO_ROOT_PASSWORD MINIO_ROOT_PASSWORD MINIO_ACCESS_KEY MINIO_SECRET_KEY REG_TOKEN SANDBOX_API_KEY WEAVIATE_ROOT_KEY PRIVOS_DEPLOYMENT_ID VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT MONGO_ROOT_USER MINIO_ROOT_USER MINIO_BUCKET ADMIN_EMAIL
load_existing_env
before_pass="$ADMIN_PASS"
generate_secrets
assert_eq "$before_pass" "$ADMIN_PASS" "generate_secrets: reuses a loaded ADMIN_PASS instead of regenerating"
assert_contains "$MONGO_URL" "$MONGO_ROOT_PASSWORD" "generate_secrets: MONGO_URL embeds the resolved mongo password"

# --- generate_secrets: fresh install fills in everything required ----------

unset ADMIN_PASS MONGO_ROOT_PASSWORD MINIO_ROOT_PASSWORD MINIO_ACCESS_KEY MINIO_SECRET_KEY REG_TOKEN SANDBOX_API_KEY WEAVIATE_ROOT_KEY PRIVOS_DEPLOYMENT_ID VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT MONGO_ROOT_USER MINIO_ROOT_USER MINIO_BUCKET ADMIN_EMAIL
generate_secrets
for v in ADMIN_PASS MONGO_ROOT_PASSWORD MINIO_ROOT_PASSWORD MINIO_ACCESS_KEY MINIO_SECRET_KEY REG_TOKEN SANDBOX_API_KEY PRIVOS_DEPLOYMENT_ID VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY; do
  assert_true=1
  [[ -n "${!v:-}" ]] && assert_true=0
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$assert_true" -eq 0 ]]; then
    echo "ok - generate_secrets: ${v} populated on a fresh install"
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    echo "not ok - generate_secrets: ${v} was left empty" >&2
  fi
done

# VAPID keys are base64url — 32-byte private key -> 43 chars, 65-byte public -> 87 chars (no padding).
assert_eq "43" "${#VAPID_PRIVATE_KEY}" "generate_vapid_keypair: private key is 32 raw bytes (base64url, unpadded)"
assert_eq "87" "${#VAPID_PUBLIC_KEY}" "generate_vapid_keypair: public key is 65 raw bytes (base64url, unpadded)"
assert_not_contains "$VAPID_PRIVATE_KEY" "=" "generate_vapid_keypair: private key has no base64 padding"
assert_not_contains "$VAPID_PRIVATE_KEY" "+" "generate_vapid_keypair: private key is base64url (no '+')"

# --- M2: env_quote / env_unquote round-trip a value containing a quote -----

tricky="admin's mailbox 'quoted' twice"
quoted="$(env_quote "$tricky")"
assert_eq "$tricky" "$(env_unquote "$quoted")" "env_unquote: reverses env_quote exactly for a value with embedded single quotes"

# Full write_env_file -> load_existing_env round-trip with a quote in a real
# field. Reuses $WORK (already trapped for cleanup at the top of this file).
# shellcheck disable=SC2034 # read by write_env_file/load_existing_env in the sourced install.sh
PRIVOS_DIR="$WORK"
ADMIN_EMAIL="o'brien@example.test"
write_env_file "$WORK/.env"
unset ADMIN_EMAIL
load_existing_env
assert_eq "o'brien@example.test" "${ADMIN_EMAIL:-}" "load_existing_env: round-trips a value containing a single quote (M2 regression)"

# --- C2: warn_if_dev_signing_key fails closed by default --------------------

# shellcheck disable=SC2034 # read by warn_if_dev_signing_key() in the sourced install.sh
MINISIGN_PUBLIC_KEY_IS_DEV_ONLY="true"
# shellcheck disable=SC2034 # read by warn_if_dev_signing_key() in the sourced install.sh
ALLOW_DEV_KEY_FLAG=""
unset PRIVOS_ALLOW_DEV_KEY 2>/dev/null
( warn_if_dev_signing_key ) >/dev/null 2>&1
assert_status 1 "$?" "warn_if_dev_signing_key: refuses to proceed with a DEV key by default"

ALLOW_DEV_KEY_FLAG="true"
( warn_if_dev_signing_key ) >/dev/null 2>&1
assert_status 0 "$?" "warn_if_dev_signing_key: proceeds with --allow-dev-signing-key"

# shellcheck disable=SC2034 # read by warn_if_dev_signing_key() in the sourced install.sh
ALLOW_DEV_KEY_FLAG=""
# shellcheck disable=SC2034 # read by warn_if_dev_signing_key() in the sourced install.sh
PRIVOS_ALLOW_DEV_KEY="1"
( warn_if_dev_signing_key ) >/dev/null 2>&1
assert_status 0 "$?" "warn_if_dev_signing_key: proceeds with PRIVOS_ALLOW_DEV_KEY=1"
unset PRIVOS_ALLOW_DEV_KEY

# shellcheck disable=SC2034 # read by warn_if_dev_signing_key() in the sourced install.sh
MINISIGN_PUBLIC_KEY_IS_DEV_ONLY="false"
( warn_if_dev_signing_key ) >/dev/null 2>&1
assert_status 0 "$?" "warn_if_dev_signing_key: no-op once a real key is embedded"
# shellcheck disable=SC2034 # restores state; not re-read again in this file
MINISIGN_PUBLIC_KEY_IS_DEV_ONLY="true"

# --- H1: validate_privos_dir rejects dangerous / malformed --dir values ----

( validate_privos_dir "/" ) >/dev/null 2>&1
assert_status 1 "$?" "validate_privos_dir: rejects '/'"

( validate_privos_dir "/usr" ) >/dev/null 2>&1
assert_status 1 "$?" "validate_privos_dir: rejects a protected system directory (/usr)"

( validate_privos_dir "/opt" ) >/dev/null 2>&1
assert_status 1 "$?" "validate_privos_dir: rejects the bare parent of the default install dir (/opt)"

( validate_privos_dir "opt/privos" ) >/dev/null 2>&1
assert_status 1 "$?" "validate_privos_dir: rejects a relative path"

( validate_privos_dir "/opt/privos/../../etc" ) >/dev/null 2>&1
assert_status 1 "$?" "validate_privos_dir: rejects a '..' traversal segment"

( validate_privos_dir '/opt/privos; rm -rf /' ) >/dev/null 2>&1
assert_status 1 "$?" "validate_privos_dir: rejects shell metacharacters"

resolved="$(validate_privos_dir "/opt/privos" 2>/dev/null)"
assert_eq "/opt/privos" "$resolved" "validate_privos_dir: accepts the real default install directory"

# --- M1: validate_port -------------------------------------------------------

( validate_port "3000" "test-port" ) >/dev/null 2>&1
assert_status 0 "$?" "validate_port: accepts a normal port"

( validate_port "0" "test-port" ) >/dev/null 2>&1
assert_status 1 "$?" "validate_port: rejects 0"

( validate_port "65536" "test-port" ) >/dev/null 2>&1
assert_status 1 "$?" "validate_port: rejects > 65535"

( validate_port "abc" "test-port" ) >/dev/null 2>&1
assert_status 1 "$?" "validate_port: rejects a non-numeric value"

( validate_port "-1" "test-port" ) >/dev/null 2>&1
assert_status 1 "$?" "validate_port: rejects a negative value"

# --- resolve_bundle_base_url: GitHub Releases, no apex/Cloudflare ----------

unset PRIVOS_BUNDLE_BASE_URL VERSION_FLAG 2>/dev/null
VERSION_FLAG=""
# shellcheck disable=SC2034 # read by resolve_bundle_base_url() in the sourced install.sh
BUNDLE_RELEASE_TAG="self-hosted-7.15.41"
assert_eq "https://github.com/PrivOS-AI/privos/releases/download/self-hosted-7.15.41" \
  "$(resolve_bundle_base_url)" "resolve_bundle_base_url: defaults to GitHub Releases at the baked tag"

VERSION_FLAG="self-hosted-9.9.9"
assert_eq "https://github.com/PrivOS-AI/privos/releases/download/self-hosted-9.9.9" \
  "$(resolve_bundle_base_url)" "resolve_bundle_base_url: --version overrides the baked tag"

# shellcheck disable=SC2034 # read by resolve_bundle_base_url() in the sourced install.sh
PRIVOS_BUNDLE_BASE_URL="https://mirror.example.test/bundle"
assert_eq "https://mirror.example.test/bundle" \
  "$(resolve_bundle_base_url)" "resolve_bundle_base_url: PRIVOS_BUNDLE_BASE_URL overrides everything"
unset PRIVOS_BUNDLE_BASE_URL
# shellcheck disable=SC2034 # read by resolve_bundle_base_url() in the sourced install.sh
VERSION_FLAG=""

assert_not_contains "$(resolve_bundle_base_url)" "privos.io" "resolve_bundle_base_url: never resolves to the dropped apex domain"

report_and_exit
