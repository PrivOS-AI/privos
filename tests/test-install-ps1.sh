#!/usr/bin/env bash
# Tests for install.ps1 (the Windows installer). Needs PowerShell (pwsh) and skips
# visibly without it. Windows-only cmdlets cannot run here, so everything that can be
# exercised on Linux is: PSScriptAnalyzer (errors), .env parity with install.sh
# (key list, key order, and a byte-for-byte rendering with identical inputs), secret
# formats, the minisign + sha256 trust chain with real signatures, port and version
# parsing, and the mongo shell scripts through a fake docker. What a real Windows run
# still has to prove is listed in the Phase 4 report.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SELF_DIR/helpers.sh"

PS1_FILE="$SELF_DIR/../install.ps1"
FIXTURES="$SELF_DIR/fixtures"

PWSH="${PRIVOS_PWSH:-}"
[[ -n "$PWSH" ]] || PWSH="$(command -v pwsh 2>/dev/null || true)"
[[ -n "$PWSH" ]] || { [[ -x "$HOME/.local/bin/pwsh" ]] && PWSH="$HOME/.local/bin/pwsh"; }
if [[ -z "$PWSH" ]]; then
  echo "SKIP: pwsh (PowerShell 7) is not installed - install.ps1 is NOT tested here (install: snap install powershell --classic, or the tarball from github.com/PowerShell/PowerShell/releases)"
  exit 0
fi

# shellcheck source=/dev/null
source "$SELF_DIR/../install.sh"
set +e

export POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off DOTNET_CLI_TELEMETRY_OPTOUT=1

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- static checks ----------------------------------------------------------

[[ -f "$PS1_FILE" ]] || { echo "not ok - install.ps1 exists"; exit 1; }

if LC_ALL=C grep -nP '[^\x00-\x7F]' "$PS1_FILE" >/dev/null; then
  TESTS_RUN=$(( TESTS_RUN + 1 )); TESTS_FAILED=$(( TESTS_FAILED + 1 ))
  echo "not ok - install.ps1 contains non-ASCII characters (irm without a charset decodes ISO-8859-1)" >&2
else
  TESTS_RUN=$(( TESTS_RUN + 1 )); echo "ok - install.ps1 is ASCII only"
fi

# Every install.sh flag has a PowerShell parameter (--install-docker is Linux-only).
sh_flags="$(sed -n '/^parse_args()/,/^}/p' "$SELF_DIR/../install.sh" | grep -oE '^[[:space:]]+--[a-z][a-z-]*\)' | tr -d ' )')"
for flag in $sh_flags; do
  [[ "$flag" == "--install-docker" ]] && continue
  pascal="$(printf '%s' "${flag#--}" | awk -F- '{ for (i = 1; i <= NF; i++) printf "%s%s", toupper(substr($i, 1, 1)), substr($i, 2) }')"
  if grep -qE "\[(string|switch)\]\\\$${pascal}\b" "$PS1_FILE"; then
    TESTS_RUN=$(( TESTS_RUN + 1 )); echo "ok - install.sh ${flag} has the install.ps1 parameter -${pascal}"
  else
    TESTS_RUN=$(( TESTS_RUN + 1 )); TESTS_FAILED=$(( TESTS_FAILED + 1 ))
    echo "not ok - install.sh ${flag} has no install.ps1 parameter -${pascal}" >&2
  fi
done

# The release placeholder must stay a single bakeable line.
assert_contains "$(cat "$PS1_FILE")" "\$script:BundleReleaseTag = 'unreleased'" "install.ps1 keeps the bakeable BundleReleaseTag placeholder line"

# --- PSScriptAnalyzer ---------------------------------------------------------

# shellcheck disable=SC2016 # $-expressions are PowerShell, expanded by pwsh
analyzer_out="$("$PWSH" -NoProfile -NonInteractive -Command '
  if (-not (Get-Module -ListAvailable PSScriptAnalyzer)) { "NOANALYZER"; exit 0 }
  Import-Module PSScriptAnalyzer
  $r = @(Invoke-ScriptAnalyzer -Path $args[0] -Severity Error)
  $r | ForEach-Object { "$($_.RuleName) line $($_.Line): $($_.Message)" }
  "ERRORS=$($r.Count)"
' "$PS1_FILE" 2>&1)"
if [[ "$analyzer_out" == *NOANALYZER* ]]; then
  echo "SKIP: PSScriptAnalyzer is not installed (pwsh -c 'Install-Module PSScriptAnalyzer -Scope CurrentUser -Force') - the analyzer gate did NOT run"
else
  if [[ "$analyzer_out" == *"ERRORS=0"* ]]; then
    TESTS_RUN=$(( TESTS_RUN + 1 )); echo "ok - Invoke-ScriptAnalyzer -Severity Error is clean for install.ps1"
  else
    TESTS_RUN=$(( TESTS_RUN + 1 )); TESTS_FAILED=$(( TESTS_FAILED + 1 ))
    echo "not ok - Invoke-ScriptAnalyzer reported errors for install.ps1:" >&2
    printf '%s\n' "$analyzer_out" >&2
  fi
fi

# --- fixtures for the PowerShell side -------------------------------------------

# Fixed values for everything random, exported so install.sh and install.ps1 render
# the same .env and can be compared byte for byte. Not secrets.
export MONGO_ROOT_PASSWORD='mongo-pass-fixture-0123456789' ADMIN_PASS='admin-pass-fixture' REG_TOKEN='reg-token-fixture'
export SANDBOX_API_KEY='sandbox-key-fixture' CATALOG_SECRET_KEY='catalog-key-fixture' RUSTFS_ROOT_PASSWORD='rustfs-root-fixture'
export RUSTFS_ACCESS_KEY='privos-fixture' RUSTFS_SECRET_KEY='rustfs-secret-fixture' WEAVIATE_ROOT_KEY='weaviate-key-fixture'
export PRIVOS_APP_CLUSTER_BOOTSTRAP_TOKEN='bootstrap-fixture' PRIVOS_SECRET_STORE_KEY='store-key-fixture'
export PRIVOS_DEPLOYMENT_ID='11111111-2222-3333-4444-555555555555' VAPID_PUBLIC_KEY='vapid-public-fixture' VAPID_PRIVATE_KEY='vapid-private-fixture'
export ADMIN_EMAIL="o'brien@example.test" PRIVOS_DIR='C:/test/PrivOS' PRIVOS_DOCKER_SOCKET_GID=0

# install.sh rendering of the same configuration: defaults, then a flags scenario.
# shellcheck disable=SC2329,SC2034 # stubs and flags are read by the sourced install.sh
render_sh_env() {  # $1 = out file, $2 = "flags" for the flags scenario
  (
    set +e
    run_ss() { :; }; run_lsof() { :; }; docker_port_lookup() { :; }
    if [[ "${2:-}" == "flags" ]]; then
      HUB_PORT_FLAG=3100; URL_FLAG=https://hub.example.test; VM_PORT_RANGE_FLAG=31000-31010
      EGRESS_ALLOWLIST_FLAG=10.20.0.0/16; VERSION_FLAG=self-hosted-9.9.9
      WITH_KNOWLEDGE_VECTOR_FLAG=true; WITHOUT_APP_CLUSTER_FLAG=true
    fi
    resolve_config >/dev/null 2>&1 && finalize_sidecar_config >/dev/null 2>&1 && generate_secrets >/dev/null 2>&1 && write_env_file "$1"
  )
}
render_sh_env "$WORK/sh-default.env"
render_sh_env "$WORK/sh-flags.env" flags
for f in sh-default sh-flags; do
  if [[ -s "$WORK/$f.env" ]]; then TESTS_RUN=$(( TESTS_RUN + 1 )); echo "ok - install.sh rendered the $f scenario for the comparison"
  else TESTS_RUN=$(( TESTS_RUN + 1 )); TESTS_FAILED=$(( TESTS_FAILED + 1 )); echo "not ok - install.sh could not render the $f scenario" >&2; fi
done

# Constants that must agree between the two installers.
{
  for v in DEFAULT_HUB_PORT DEFAULT_BOARD_PORT DEFAULT_PROXY_PORT DEFAULT_RUSTFS_PORT DEFAULT_VM_PORT_RANGE MIN_RAM_MB \
           STACK_READY_TIMEOUT_SEC NETWORK_NAME AGENT_NETWORK_NAME AGENT_NETWORK_BRIDGE_IFACE PROJECT_NAME LICENSE_VERSION \
           MAX_PORT_RANGE_SPAN LICENSE_MARKER_FILE MINISIGN_PUBLIC_KEY MINISIGN_PUBLIC_KEY_IS_DEV_ONLY; do
    printf '%s=%s\n' "$v" "${!v}"
  done
  printf 'BUNDLE_FILES=%s\n' "$(printf '%s\n' "${BUNDLE_FILES[@]}" | grep -vx 'compose.desktop.yml' | paste -sd, -)"
  printf 'UNSIGNED_HASHED_FILES=%s\n' "$(printf '%s\n' "${UNSIGNED_HASHED_FILES[@]}" | grep -vx 'compose.desktop.yml' | paste -sd, -)"
} > "$WORK/sh-consts.txt"

# A signed bundle made with a throwaway key: the real trust-chain code path.
BUNDLE_ARGS=()
if command -v minisign >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  BUNDLE="$WORK/bundle"; mkdir -p "$BUNDLE"
  for f in compose.yml compose.desktop.yml rustfs-init.sh docker-user-rules.sh LICENSE NOTICE OPEN-SOURCE-NOTICES rocketchat-upstream-files.txt TRADEMARK.md; do
    printf 'fixture content of %s\n' "$f" > "$BUNDLE/$f"
  done
  files='{}'
  for f in rustfs-init.sh docker-user-rules.sh LICENSE NOTICE OPEN-SOURCE-NOTICES rocketchat-upstream-files.txt TRADEMARK.md compose.desktop.yml; do
    files="$(jq -c --arg f "$f" --arg s "$(sha256_file "$BUNDLE/$f")" '.[$f] = {sha256: $s}' <<<"$files")"
  done
  jq -n --argjson files "$files" '{stackVersion: "9.9.9-test", files: $files}' > "$BUNDLE/versions.json"
  minisign -G -W -f -p "$WORK/k.pub" -s "$WORK/k.sec" >/dev/null 2>&1
  for f in compose.yml compose.desktop.yml versions.json; do
    minisign -S -s "$WORK/k.sec" -m "$BUNDLE/$f" -x "$BUNDLE/$f.minisig" >/dev/null 2>&1
  done
  BUNDLE_ARGS=(-BundleDir "$BUNDLE" -PubKey "$(sed -n 2p "$WORK/k.pub")" -MinisignExe "$(command -v minisign)")
else
  echo "SKIP: minisign or jq missing - the install.ps1 signature chain was NOT exercised"
fi

# Fake docker + mongosh: Initialize-ReplicaSet and the local-runtime guard are run for real
# (base64 transport, quoting, $-operators) against a shell that only records the mongosh call.
FAKE="$WORK/fakebin"; mkdir -p "$FAKE"
cat > "$FAKE/docker" <<'EOF'
#!/bin/sh
# `docker run ...` (the docker-socket group probe): record the call, answer from the environment.
if [ "$1" = run ]; then
  echo "$@" >> "$FAKE_DOCKER_LOG"
  echo "${FAKE_SOCKET_GID:-}"
  exit "${FAKE_RUN_RC:-0}"
fi
# Emulates `docker compose ... exec -T mongo sh -c "<cmd>"`: runs <cmd> locally.
for a; do last="$a"; done
MONGO_INITDB_ROOT_USERNAME=fake-root-user MONGO_INITDB_ROOT_PASSWORD=fake-root-pass exec sh -c "$last"
EOF
cat > "$FAKE/mongosh" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" >> "$FAKE_MONGOSH_LOG"
printf '%s\n' "$FAKE_MONGOSH_OUT"
exit "${FAKE_MONGOSH_RC:-0}"
EOF
chmod +x "$FAKE/docker" "$FAKE/mongosh"

# Expected mongo keyfile for the pinned password, from install.sh itself.
EXPECTED_KEYFILE="$(mongo_keyfile_content "$MONGO_ROOT_PASSWORD")"

# --- run the PowerShell test body --------------------------------------------------

mkdir -p "$WORK/pswork"
ps_out="$("$PWSH" -NoProfile -NonInteractive -File "$FIXTURES/ps1-parity-test.ps1" \
  -InstallPs1 "$PS1_FILE" -KeysFile "$FIXTURES/env-keys.txt" -FixtureDir "$FIXTURES" -WorkDir "$WORK/pswork" \
  -ShEnvDefault "$WORK/sh-default.env" -ShEnvFlags "$WORK/sh-flags.env" -ShConstsFile "$WORK/sh-consts.txt" \
  -KeyfilePassword "$MONGO_ROOT_PASSWORD" -ExpectedKeyfile "$EXPECTED_KEYFILE" -FakeBinDir "$FAKE" \
  "${BUNDLE_ARGS[@]}" 2>&1)"
ps_rc=$?
printf '%s\n' "$ps_out"

ps_ok="$(printf '%s\n' "$ps_out" | grep -c '^ok - ')"
ps_bad="$(printf '%s\n' "$ps_out" | grep -c '^not ok - ')"
TESTS_RUN=$(( TESTS_RUN + ps_ok + ps_bad ))
TESTS_FAILED=$(( TESTS_FAILED + ps_bad ))
if [[ "$ps_rc" -ne 0 && "$ps_bad" -eq 0 ]]; then
  TESTS_RUN=$(( TESTS_RUN + 1 )); TESTS_FAILED=$(( TESTS_FAILED + 1 ))
  echo "not ok - ps1-parity-test.ps1 exited ${ps_rc} without reporting a failure (crashed?)" >&2
fi

# --- VAPID keypair consistency, checked by openssl (independent of .NET) -------------

vapid_value() { sed -n "s/^$1='\(.*\)'\$/\1/p" "$WORK/pswork/fresh.env"; }
b64url_to_hex() {
  local s="${1//-/+}"
  s="${s//_//}"
  while (( ${#s} % 4 != 0 )); do s="${s}="; done
  printf '%s' "$s" | base64 -d | od -An -vtx1 | tr -d ' \n'
}
vp="$(vapid_value VAPID_PUBLIC_KEY)"; vd="$(vapid_value VAPID_PRIVATE_KEY)"
if [[ -n "$vp" && -n "$vd" ]] && command -v openssl >/dev/null 2>&1 && command -v xxd >/dev/null 2>&1; then
  pub_hex="$(b64url_to_hex "$vp")"; priv_hex="$(b64url_to_hex "$vd")"
  printf '%s' "30770201010420${priv_hex}a00a06082a8648ce3d030107a144034200${pub_hex}" | xxd -r -p > "$WORK/vapid.der"
  check_out="$(openssl ec -inform DER -in "$WORK/vapid.der" -check -noout 2>&1)"
  assert_contains "$check_out" "EC Key valid" "install.ps1 VAPID private and public key form a valid P-256 pair (openssl -check)"
  openssl_pub="$(openssl ec -inform DER -in "$WORK/vapid.der" -noout -text 2>/dev/null | sed -n '/^pub:/,/^ASN1 OID/p' | sed '1d;$d' | tr -d ' \n:')"
  assert_eq "$pub_hex" "$openssl_pub" "install.ps1 VAPID public key is the point openssl derives from the private key"
else
  echo "SKIP: openssl/xxd missing or no VAPID keys rendered - VAPID pair consistency NOT checked"
fi

report_and_exit
