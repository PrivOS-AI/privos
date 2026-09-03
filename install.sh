#!/usr/bin/env bash
# PrivOS self-hosted installer.
#
#   curl -fsSL https://github.com/PrivOS-AI/privos/releases/latest/download/install.sh | sudo bash
#
# Installs hub + sandbox (mongo, redis, minio, board, proxy, VM pool) as a
# single-host Docker Compose stack. Idempotent: safe to re-run. See
# docs/self-hosted-install.md for the full model this implements.
#
# Flags: --version <tag> --dir <path> --url <root-url> --hub-port <port>
#        --vm-port-range <lo-hi> --yes --accept-license --upgrade --uninstall
#        [--purge] --with-knowledge-vector --with-local-runtime
#        --install-docker --allow-dev-signing-key
#
# Distributed under the PrivOS Community License 1.0 (LICENSE, PCL-1.0) — a
# source-available license with commercial/hosting terms, not an OSI-approved
# license. --yes implies license acceptance; --accept-license accepts it
# without --yes's other non-interactive effects. See
# require_license_acceptance() below.
#
# This file is dual-purpose: run directly it installs the stack; sourced (as
# `tests/` does) it only defines functions — nothing runs until `main` is
# invoked by the guard at the bottom.
set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# The bundle (compose.yml, versions.json, minio-init.sh, docker-user-rules.sh,
# .minisig files) is served as flat GitHub Release assets — no apex domain,
# no Cloudflare Worker. `releases/latest/download/install.sh` is how a user
# curls THIS file; publish-self-hosted-bundle.sh bakes the concrete release
# tag into BUNDLE_RELEASE_TAG below before uploading, so a no-arg install
# fetches the rest of that SAME release's assets by default. `--version`
# overrides the tag; PRIVOS_BUNDLE_BASE_URL overrides the whole base URL
# (e.g. for a private mirror or local testing).
GITHUB_RELEASES_OWNER_REPO="PrivOS-AI/privos"
GITHUB_RELEASES_BASE="https://github.com/${GITHUB_RELEASES_OWNER_REPO}/releases/download"
# Baked by publish-self-hosted-bundle.sh at publish time (sed-replaces this
# placeholder with the real tag, e.g. "self-hosted-v1.2.3") — same mechanism
# as the compose.yml image-digest placeholders.
BUNDLE_RELEASE_TAG="unreleased"

resolve_bundle_base_url() {
  if [[ -n "${PRIVOS_BUNDLE_BASE_URL:-}" ]]; then
    printf '%s' "$PRIVOS_BUNDLE_BASE_URL"
    return
  fi
  printf '%s/%s' "$GITHUB_RELEASES_BASE" "${VERSION_FLAG:-$BUNDLE_RELEASE_TAG}"
}

# DEV-ONLY scaffold key — see SIGNING.md. MUST be replaced with the real,
# offline-held production public key before this script is ever published.
# Read by warn_if_dev_signing_key() at startup — flip to "false" once
# MINISIGN_PUBLIC_KEY below is the real production key.
MINISIGN_PUBLIC_KEY_IS_DEV_ONLY="false"
MINISIGN_PUBLIC_KEY="RWQVDoIkZD9NNKyCJhKYcl7tGiAAys+Pp+PvLH1DJ5Ai1Ze7nTzm3cK2"

# Fails closed: a DEV-signed bundle must never become an install's trust
# root by accident (e.g. scrolling past a warning under `curl | bash`).
# --allow-dev-signing-key / PRIVOS_ALLOW_DEV_KEY=1 is an explicit escape
# hatch for our own local testing only — see SIGNING.md.
warn_if_dev_signing_key() {
  [[ "$MINISIGN_PUBLIC_KEY_IS_DEV_ONLY" == "true" ]] || return 0
  if [[ "$ALLOW_DEV_KEY_FLAG" == "true" || "${PRIVOS_ALLOW_DEV_KEY:-}" == "1" ]]; then
    log "WARNING: proceeding with the DEV-ONLY scaffold signing key (--allow-dev-signing-key / PRIVOS_ALLOW_DEV_KEY=1) — do not use for a production install."
    return 0
  fi
  die "refusing to install with a DEV-ONLY signing key (see SIGNING.md) — this build of install.sh has not been re-signed with a production key. Pass --allow-dev-signing-key or set PRIVOS_ALLOW_DEV_KEY=1 only for local testing."
}

DEFAULT_DIR="/opt/privos"
DEFAULT_HUB_PORT=3000
DEFAULT_BOARD_PORT=8556
DEFAULT_PROXY_PORT=8557
DEFAULT_MINIO_PORT=9000
DEFAULT_VM_PORT_RANGE="30000-30999"
MIN_RAM_MB=3800
MIN_DISK_KB=$(( 20 * 1024 * 1024 ))
MIN_DOCKER_MAJOR=24
PROJECT_NAME="privos"
NETWORK_NAME="privos-sandbox-net"
STACK_READY_TIMEOUT_SEC=600

BUNDLE_FILES=(compose.yml versions.json minio-init.sh docker-user-rules.sh LICENSE NOTICE OPEN-SOURCE-NOTICES rocketchat-upstream-files.txt TRADEMARK.md)
SIGNED_FILES=(compose.yml versions.json)
# Not directly minisig-signed, but versions.json's files{} block (itself
# covered by the versions.json signature) carries a sha256 for each of
# these — verify_bundle_integrity() checks both before either file is
# installed, mounted, or executed. minio-init.sh/docker-user-rules.sh run as
# root / with root-equivalent access (systemd unit + iptables; MinIO root
# creds in the mc container); LICENSE is hashed the same way so the text an
# operator accepts can never silently diverge from what was actually signed.
# NOTICE/OPEN-SOURCE-NOTICES/rocketchat-upstream-files.txt/TRADEMARK.md are
# on the same trust path for the same reason: NOTICE requires all five files
# to be passed on together, so none of them may be swapped after signing.
UNSIGNED_HASHED_FILES=(minio-init.sh docker-user-rules.sh LICENSE NOTICE OPEN-SOURCE-NOTICES rocketchat-upstream-files.txt TRADEMARK.md)
LICENSE_MARKER_FILE=".license-accepted"
LICENSE_VERSION="PCL-1.0"
MAX_PORT_RANGE_SPAN=5000
DANGEROUS_DIRS=(/ /root /home /usr /usr/local /etc /bin /sbin /lib /lib64 /var /boot /dev /proc /sys /opt /tmp /srv /mnt /media /run)

# .env keys, in the order they are written — must match env.template.
ENV_KEYS=(
  PRIVOS_DIR PRIVOS_PROJECT PRIVOS_NETWORK PRIVOS_STACK_VERSION PRIVOS_ROOT_URL PRIVOS_DEPLOYMENT_ID
  PRIVOS_HUB_PORT PRIVOS_BOARD_PORT PRIVOS_PROXY_PORT PRIVOS_MINIO_PORT PRIVOS_VM_PORT_RANGE
  MONGO_ROOT_USER MONGO_ROOT_PASSWORD MONGO_URL MONGO_OPLOG_URL MONGODB_URL
  PRIVOS_MONGO_CACHE_GB PRIVOS_MONGO_MEM PRIVOS_MONGO_CPUS
  MINIO_ROOT_USER MINIO_ROOT_PASSWORD MINIO_ACCESS_KEY MINIO_SECRET_KEY MINIO_BUCKET
  PRIVOS_MINIO_MEM PRIVOS_MINIO_CPUS
  ADMIN_PASS ADMIN_EMAIL REG_TOKEN VAPID_SUBJECT VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY SANDBOX_API_KEY
  SERVICE_USAGE_AUTHORIZATION_FAIL_CLOSED
  PRIVOS_HUB_MEM PRIVOS_HUB_CPUS PRIVOS_BOARD_MEM PRIVOS_BOARD_CPUS PRIVOS_PROXY_MEM PRIVOS_PROXY_CPUS
  PRIVOS_LLM_PROVIDER ANTHROPIC_API_KEY OPENAI_API_KEY PRIVOS_LLM_BASE_URL
  PRIVOS_WITH_KNOWLEDGE_VECTOR PRIVOS_WEAVIATE_URL WEAVIATE_ROOT_KEY PRIVOS_WEAVIATE_MEM PRIVOS_WEAVIATE_CPUS
  PRIVOS_WITH_LOCAL_RUNTIME PRIVOS_DOCKER_SOCKET_GID PRIVOS_LOCAL_RUNTIME_ENDPOINT_HOSTS PRIVOS_LOCAL_RUNTIME_MEM PRIVOS_LOCAL_RUNTIME_CPUS
  COMPOSE_PROFILES
)

# ---------------------------------------------------------------------------
# Logging — never print secret values.
# ---------------------------------------------------------------------------

log()  { printf '[privos-install] %s\n' "$*" >&2; }
die()  { printf '[privos-install] ERROR: %s\n' "$*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

# ---------------------------------------------------------------------------
# Failure reporting — nothing here rolls back partial state (a mid-`compose
# pull` network blip should not delete secrets that took real work to
# generate); every stage is safe to retry, so on a failure the trap just
# names the stage and tells the operator re-running converges.
# ---------------------------------------------------------------------------

CURRENT_STAGE="startup"
TRAP_FIRED="false"

set_stage() { CURRENT_STAGE="$1"; }

on_err() {
  local rc=$?
  [[ "$TRAP_FIRED" == "true" ]] && exit "$rc"
  TRAP_FIRED="true"
  trap - ERR EXIT
  if (( rc != 0 )); then
    {
      echo ""
      echo "[privos-install] Install did not complete (stage: ${CURRENT_STAGE}, exit ${rc})."
      echo "[privos-install] Nothing here rolls back destructively — re-running install.sh is safe and reuses what was already written (secrets, .env), retrying only what failed."
    } >&2
  fi
  exit "$rc"
}

usage() {
  cat <<'USAGE'
PrivOS self-hosted installer

  curl -fsSL https://github.com/PrivOS-AI/privos/releases/latest/download/install.sh | sudo bash

Flags:
  --version <tag>          Bundle/stack version to install (default: latest published)
  --dir <path>              Install directory (default: /opt/privos)
  --url <root-url>          Public URL the hub is reachable at (rewrites ROOT_URL on re-run)
  --hub-port <port>         Host port for the hub (default: 3000)
  --vm-port-range <lo-hi>   Loopback host-port range for the sandbox VM pool (default: 30000-30999)
  --yes                     Non-interactive: assume "no" for optional-sidecar prompts AND
                            accept the PrivOS Community License 1.0 (see LICENSE)
  --accept-license          Accept the PrivOS Community License 1.0 without --yes's other effects
  --upgrade                 Pull latest images for the current install and recreate containers
  --uninstall               Stop and remove the stack (add --purge to also delete data)
  --purge                   With --uninstall: also delete data, volumes, network, firewall rules
  --with-knowledge-vector    Enable the Weaviate knowledge-vector sidecar
  --with-local-runtime       Enable the local-runtime (MCP apps on this host) sidecar
  --install-docker          Install Docker + compose v2 automatically if missing
  --allow-dev-signing-key   Local testing only: proceed despite a DEV-ONLY minisign key
  -h, --help                Show this help

License: PrivOS Community License 1.0 (PCL-1.0) — free for up to 10 Active
Human Users (people who sign in with an account; bots, integrations, AI
agents, and guests who never sign in do not count), counted across all
deployments your company runs. More than that, hosted/managed services, and
commercial redistribution require a license from Roxane, Inc.
(legal@privos.ai). Full text: <install dir>/LICENSE (default /opt/privos) and
https://github.com/PrivOS-AI/privos/blob/main/LICENSE — plain-English FAQ:
https://github.com/PrivOS-AI/privos/blob/main/LICENSE-FAQ.md
USAGE
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

MODE="install"
PURGE="false"
ASSUME_YES="false"
INSTALL_DOCKER="false"
VERSION_FLAG=""
DIR_FLAG=""
URL_FLAG=""
HUB_PORT_FLAG=""
VM_PORT_RANGE_FLAG=""
WITH_KNOWLEDGE_VECTOR_FLAG=""
WITH_LOCAL_RUNTIME_FLAG=""
ALLOW_DEV_KEY_FLAG=""
ACCEPT_LICENSE_FLAG=""

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version) VERSION_FLAG="${2:?--version requires a value}"; shift 2 ;;
      --dir) DIR_FLAG="${2:?--dir requires a value}"; shift 2 ;;
      --url) URL_FLAG="${2:?--url requires a value}"; shift 2 ;;
      --hub-port) HUB_PORT_FLAG="${2:?--hub-port requires a value}"; shift 2 ;;
      --vm-port-range) VM_PORT_RANGE_FLAG="${2:?--vm-port-range requires a value}"; shift 2 ;;
      --yes) ASSUME_YES="true"; shift ;;
      --upgrade) MODE="upgrade"; shift ;;
      --uninstall) MODE="uninstall"; shift ;;
      --purge) PURGE="true"; shift ;;
      --with-knowledge-vector) WITH_KNOWLEDGE_VECTOR_FLAG="true"; shift ;;
      --with-local-runtime) WITH_LOCAL_RUNTIME_FLAG="true"; shift ;;
      --install-docker) INSTALL_DOCKER="true"; shift ;;
      --allow-dev-signing-key) ALLOW_DEV_KEY_FLAG="true"; shift ;;
      --accept-license) ACCEPT_LICENSE_FLAG="true"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown flag: $1 (see --help)" ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

require_root() {
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "run as root: curl -fsSL https://github.com/${GITHUB_RELEASES_OWNER_REPO}/releases/latest/download/install.sh | sudo bash"
}

# --dir/PRIVOS_DIR flows into mkdir/chown/bind-mount paths and
# `rm -rf "$PRIVOS_DIR"` under --uninstall --purge — validate it strictly
# before it is used anywhere. Prints the resolved (canonicalized when the
# path already exists) directory on stdout; dies on anything unsafe.
validate_privos_dir() {
  local dir="$1" resolved d
  [[ -n "$dir" ]] || die "--dir must not be empty"
  [[ "$dir" == /* ]] || die "--dir must be an absolute path (got: ${dir})"
  [[ "$dir" =~ ^[A-Za-z0-9_./-]+$ ]] || die "--dir contains unsupported characters (got: ${dir}) — use plain path characters only."
  case "$dir" in
    *"/../"*|*"/..") die "--dir must not contain '..' path segments (got: ${dir})" ;;
  esac
  case "$dir" in
    *"/./"*|*"/.") die "--dir must not contain '.' path segments (got: ${dir})" ;;
  esac

  if [[ -e "$dir" ]]; then
    resolved="$(cd "$dir" && pwd -P)"
  else
    resolved="$dir"
  fi
  [[ "$resolved" != "/" ]] && resolved="${resolved%/}"

  for d in "${DANGEROUS_DIRS[@]}"; do
    [[ "$resolved" == "$d" ]] && die "--dir resolves to ${resolved}, a protected system directory — refusing (this value is later passed to 'rm -rf' under --purge)."
  done
  [[ -n "${HOME:-}" && "$resolved" == "$HOME" ]] && die "--dir resolves to \$HOME (${resolved}) — refusing (this value is later passed to 'rm -rf' under --purge)."

  printf '%s' "$resolved"
}

validate_port() {
  local val="$1" label="$2"
  [[ "$val" =~ ^[0-9]+$ ]] || die "${label} must be a positive integer (got: ${val})"
  (( val >= 1 && val <= 65535 )) || die "${label} must be between 1 and 65535 (got: ${val})"
}

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  [[ "$os" == "Linux" ]] || die "this installer supports Linux only (found: ${os})."
  case "$arch" in
    x86_64|aarch64|arm64) ;;
    *) die "unsupported architecture: ${arch} (supported: x86_64, aarch64/arm64)." ;;
  esac
  log "Platform: ${os} ${arch}"
}

check_docker_version() {
  command -v docker >/dev/null 2>&1 || return 1
  local ver major
  ver="$(docker version --format '{{.Server.Version}}' 2>/dev/null)" || return 1
  major="${ver%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  (( major >= MIN_DOCKER_MAJOR ))
}

check_compose_v2() {
  docker compose version >/dev/null 2>&1
}

ensure_docker() {
  if check_docker_version && check_compose_v2; then
    return 0
  fi
  if [[ "$INSTALL_DOCKER" == "true" ]]; then
    log "Installing Docker (get.docker.com)…"
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker >/dev/null 2>&1 || true
    if ! check_docker_version || ! check_compose_v2; then
      die "Docker install completed but the version/compose check still fails — install Docker >= ${MIN_DOCKER_MAJOR} with the compose v2 plugin manually."
    fi
  else
    die "Docker >= ${MIN_DOCKER_MAJOR} with the compose v2 plugin ('docker compose') is required. Re-run with --install-docker to install it automatically, or install it yourself first."
  fi
}

check_resources() {
  local mem_kb mem_mb check_dir avail_kb
  mem_kb="$(awk '/^MemTotal:/{print $2}' /proc/meminfo)"
  mem_mb=$(( mem_kb / 1024 ))
  (( mem_mb >= MIN_RAM_MB )) || die "at least ~4 GB RAM is required (found ${mem_mb} MB)."
  check_dir="$PRIVOS_DIR"
  while [[ ! -d "$check_dir" && "$check_dir" != "/" ]]; do check_dir="$(dirname "$check_dir")"; done
  avail_kb="$(df -Pk "$check_dir" | awk 'NR==2{print $4}')"
  (( avail_kb >= MIN_DISK_KB )) || die "at least 20 GB free disk is required at ${PRIVOS_DIR} (found $(( avail_kb / 1024 / 1024 )) GB free)."
}

# ---------------------------------------------------------------------------
# License acceptance — must run before ANY other install state is written
# (directories, secrets, .env). Never treat silence as acceptance: a bare
# Enter at the TTY prompt, or no TTY and no explicit flag/env, both refuse.
# ---------------------------------------------------------------------------

license_already_accepted() {
  local marker="$PRIVOS_DIR/$LICENSE_MARKER_FILE"
  [[ -f "$marker" ]] || return 1
  grep -q "$LICENSE_VERSION" "$marker" 2>/dev/null
}

print_license_notice() {
  cat >&2 <<EOF

PrivOS is licensed under the PrivOS Community License 1.0: free for up to 10
Active Human Users — people who sign in with an account — counted across all
deployments your company runs; bots, integrations, AI agents, and guests who
never sign in do not count. More than that, hosted/managed services, and
commercial redistribution require a license from Roxane, Inc. Full text:
${PRIVOS_DIR}/LICENSE (after install) and
https://github.com/PrivOS-AI/privos/blob/main/LICENSE — plain-English FAQ:
https://github.com/PrivOS-AI/privos/blob/main/LICENSE-FAQ.md

EOF
}

# --yes implies acceptance (see usage()); --accept-license / PRIVOS_ACCEPT_LICENSE=1
# accept without --yes's other non-interactive effects. Sets LICENSE_ACCEPTED=true
# only when THIS run newly accepted — write_license_marker() checks that flag.
require_license_acceptance() {
  if license_already_accepted; then
    log "License already accepted (${PRIVOS_DIR}/${LICENSE_MARKER_FILE})."
    return 0
  fi

  print_license_notice

  if [[ "$ASSUME_YES" == "true" || "$ACCEPT_LICENSE_FLAG" == "true" || "${PRIVOS_ACCEPT_LICENSE:-}" == "1" ]]; then
    log "License accepted (--yes/--accept-license or PRIVOS_ACCEPT_LICENSE=1)."
    LICENSE_ACCEPTED="true"
    return 0
  fi

  if [[ -t 0 ]]; then
    local ans=""
    read -r -p "Accept the license? [y/N] " ans || ans=""
    if [[ "$ans" =~ ^[Yy] ]]; then
      LICENSE_ACCEPTED="true"
      return 0
    fi
    die "license not accepted — installation stopped."
  fi

  die "cannot prompt for license acceptance (no TTY). Re-run with --yes or --accept-license, or set PRIVOS_ACCEPT_LICENSE=1, after reading the license."
}

# Called once $PRIVOS_DIR exists (right after directory creation) — a no-op
# unless require_license_acceptance() set LICENSE_ACCEPTED=true THIS run
# (already-accepted re-runs never touch the existing marker).
write_license_marker() {
  [[ "${LICENSE_ACCEPTED:-}" == "true" ]] || return 0
  printf '%s\naccepted_at=%s\n' "$LICENSE_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$PRIVOS_DIR/$LICENSE_MARKER_FILE"
  chmod 0644 "$PRIVOS_DIR/$LICENSE_MARKER_FILE"
}

# ---------------------------------------------------------------------------
# Bundle source (remote fetch, or a local sibling checkout for dev/tests)
# ---------------------------------------------------------------------------

resolve_script_path() {
  if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
    printf '%s' "${BASH_SOURCE[0]}"
  else
    printf '%s' "$0"
  fi
}

resolve_bundle_source() {
  local script_path script_dir
  script_path="$(resolve_script_path)"
  BUNDLE_SOURCE_MODE="remote"
  BUNDLE_SOURCE_DIR=""
  if [[ -r "$script_path" && "$script_path" != "bash" && "$script_path" != "sh" && "$script_path" != "/dev/stdin" ]]; then
    script_dir="$(cd "$(dirname "$script_path")" && pwd)"
    if [[ -f "$script_dir/compose.yml" && -f "$script_dir/versions.json" ]]; then
      BUNDLE_SOURCE_MODE="local"
      BUNDLE_SOURCE_DIR="$script_dir"
    fi
  fi
  log "Bundle source: ${BUNDLE_SOURCE_MODE}${BUNDLE_SOURCE_DIR:+ (${BUNDLE_SOURCE_DIR})}"
}

fetch_bundle_file() {
  local name="$1" dest="$2"
  if [[ "$BUNDLE_SOURCE_MODE" == "local" ]]; then
    if [[ -f "$BUNDLE_SOURCE_DIR/$name" ]]; then
      cp "$BUNDLE_SOURCE_DIR/$name" "$dest"
    fi
    return 0
  fi
  local url
  url="$(resolve_bundle_base_url)/${name}"
  curl -fsSL "$url" -o "$dest" || die "failed to download ${url}"
}

fetch_bundle() {
  local dest_dir="$1" name
  mkdir -p "$dest_dir"
  for name in "${BUNDLE_FILES[@]}"; do
    fetch_bundle_file "$name" "$dest_dir/$name"
  done
  for name in "${SIGNED_FILES[@]}"; do
    fetch_bundle_file "${name}.minisig" "$dest_dir/${name}.minisig"
  done
  for name in "${BUNDLE_FILES[@]}"; do
    [[ -f "$dest_dir/$name" ]] || die "bundle is missing ${name} after fetch"
  done
}

verify_signature() {
  local file="$1"
  [[ -f "${file}.minisig" ]] || die "missing signature file ${file}.minisig — refusing to use an unsigned bundle."
  minisign -Vq -m "$file" -x "${file}.minisig" -P "$MINISIGN_PUBLIC_KEY" \
    || die "signature verification FAILED for ${file} — refusing to use a tampered or corrupted bundle."
  log "Signature OK: $(basename "$file")"
}

sha256_file() {
  # sha256sum (GNU coreutils) is present on every real target (Linux); the
  # shasum fallback exists only so tests/ can run this on macOS dev boxes.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

bundle_file_sha256_from_versions_json() {
  local name="$1" versions_json="$2"
  jq -r --arg f "$name" '.files[$f].sha256 // empty' "$versions_json"
}

# Not every bundle file is directly minisig-signed (only compose.yml and
# versions.json are). minio-init.sh and docker-user-rules.sh are instead
# hash-pinned INSIDE the signed versions.json (files{} block) — verify
# against that hash before either file is ever installed, mounted, or
# executed. Fails closed on a missing or mismatched hash.
verify_bundle_file_hash() {
  local name="$1" dir="$2" versions_json="$3" expected actual
  expected="$(bundle_file_sha256_from_versions_json "$name" "$versions_json")"
  [[ -n "$expected" ]] || die "versions.json has no files[\"${name}\"].sha256 entry — refusing to use an unverifiable bundle file."
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || die "versions.json files[\"${name}\"].sha256 is not a well-formed sha256 hex digest."
  actual="$(sha256_file "$dir/$name")"
  [[ "$expected" == "$actual" ]] || die "sha256 mismatch for ${name} (expected ${expected}, got ${actual}) — refusing to install/execute a tampered bundle file."
  log "sha256 OK: ${name}"
}

# Full bundle trust chain: minisig-verify the two signed files, then
# hash-verify every remaining bundle file against the (now-trusted)
# versions.json. Must run to completion before anything in $dir is used.
verify_bundle_integrity() {
  local dir="$1" f
  require_cmd jq
  for f in "${SIGNED_FILES[@]}"; do
    verify_signature "$dir/$f"
  done
  for f in "${UNSIGNED_HASHED_FILES[@]}"; do
    verify_bundle_file_hash "$f" "$dir" "$dir/versions.json"
  done
}

# ---------------------------------------------------------------------------
# Port-conflict detection
#
# ss/lsof access is wrapped in run_ss/run_lsof and docker inspection in
# docker_port_lookup so tests/ can redefine these after sourcing this file
# and exercise the parsers against fixture text with no real ss/lsof/docker.
# ---------------------------------------------------------------------------

run_ss()  { ss -ltnHp 2>/dev/null; }
run_lsof() { lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null; }
docker_port_lookup() { docker inspect -f '{{json .NetworkSettings.Ports}}' "$1" 2>/dev/null; }
# Indirected (not an inline `command -v ss`) so tests/ can force the ss or
# lsof code path deterministically regardless of what the host running the
# test actually has installed.
have_ss()   { command -v ss >/dev/null 2>&1; }
have_lsof() { command -v lsof >/dev/null 2>&1; }

declare -gA LISTEN_PID=()
declare -gA LISTEN_CMD=()

parse_ss_output() {
  # Reads ss -ltnHp lines on stdin; populates LISTEN_PID[port]/LISTEN_CMD[port].
  local line addr port pidcmd pid cmd
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    addr="$(awk '{print $4}' <<<"$line")"
    port="${addr##*:}"
    [[ "$port" =~ ^[0-9]+$ ]] || continue
    pidcmd="$(grep -oE '\(\("[^"]+",pid=[0-9]+' <<<"$line" || true)"
    cmd="$(sed -E 's/\(\("([^"]+)".*/\1/' <<<"$pidcmd")"
    pid="$(sed -E 's/.*pid=([0-9]+).*/\1/' <<<"$pidcmd")"
    LISTEN_PID["$port"]="${pid:-?}"
    LISTEN_CMD["$port"]="${cmd:-unknown}"
  done
}

parse_lsof_output() {
  # Reads `lsof -iTCP -sTCP:LISTEN -P -n` lines on stdin (header line skipped).
  local line cmd pid name port
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == COMMAND* ]] && continue
    cmd="$(awk '{print $1}' <<<"$line")"
    pid="$(awk '{print $2}' <<<"$line")"
    name="$(awk '{print $(NF-1)}' <<<"$line")"
    port="${name##*:}"
    [[ "$port" =~ ^[0-9]+$ ]] || continue
    LISTEN_PID["$port"]="$pid"
    LISTEN_CMD["$port"]="$cmd"
  done
}

collect_listeners() {
  LISTEN_PID=()
  LISTEN_CMD=()
  if have_ss; then
    parse_ss_output < <(run_ss)
  elif have_lsof; then
    parse_lsof_output < <(run_lsof)
  else
    die "neither ss nor lsof is available — cannot perform the port-conflict check."
  fi
}

port_already_ours() {
  local port="$1" name json
  for name in hub sandbox-board sandbox-proxy minio; do
    json="$(docker_port_lookup "${PROJECT_NAME}-${name}")"
    [[ -n "$json" ]] || continue
    grep -q "\"HostPort\":\"${port}\"" <<<"$json" && return 0
  done
  return 1
}

expand_port_range() {
  local range="$1" start end span
  start="${range%-*}"
  end="${range#*-}"
  [[ "$start" =~ ^[0-9]+$ && "$end" =~ ^[0-9]+$ ]] || die "invalid port range: ${range}"
  (( start >= 1 && start <= 65535 )) || die "invalid port range: ${range} (start must be 1-65535)"
  (( end >= 1 && end <= 65535 )) || die "invalid port range: ${range} (end must be 1-65535)"
  (( start <= end )) || die "invalid port range: ${range} (start must be <= end)"
  span=$(( end - start + 1 ))
  (( span <= MAX_PORT_RANGE_SPAN )) || die "invalid port range: ${range} spans ${span} ports — refusing (max ${MAX_PORT_RANGE_SPAN})"
  seq "$start" "$end"
}

check_ports() {
  local -a requested=("$@")
  local -a conflicts=()
  local port
  collect_listeners
  for port in "${requested[@]}"; do
    [[ -n "${LISTEN_PID[$port]:-}" ]] || continue
    port_already_ours "$port" && continue
    conflicts+=("$port")
  done
  if (( ${#conflicts[@]} > 0 )); then
    {
      echo "Port conflict — refusing to write any state:"
      printf '%-8s %-10s %s\n' "PORT" "PID" "COMMAND"
      for port in "${conflicts[@]}"; do
        printf '%-8s %-10s %s\n' "$port" "${LISTEN_PID[$port]}" "${LISTEN_CMD[$port]}"
      done
      echo ""
      echo "Override with --hub-port / --vm-port-range, or stop the owning process, then re-run."
    } >&2
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

rand_hex() { openssl rand -hex "${1:-32}"; }

rand_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    cat /proc/sys/kernel/random/uuid
  fi
}

hex_to_base64url() {
  local hex="$1" escaped
  escaped="$(printf '%s' "$hex" | sed 's/\(..\)/\\x\1/g')"
  printf '%b' "$escaped" | openssl base64 -A | tr '+/' '-_' | tr -d '='
}

mongo_keyfile_content() {
  printf 'keyfile:%s' "$1" | openssl dgst -sha512 -binary | openssl base64 -A
}

# Web Push VAPID keypair: a raw P-256 (prime256v1) keypair, base64url encoded
# (RFC 8292 §2 — public key is the 65-byte uncompressed point, private key is
# the raw 32-byte scalar). No node/npm dependency: pure openssl + sed.
generate_vapid_keypair() {
  local key_pem priv_hex pub_hex
  key_pem="$(mktemp)"
  openssl ecparam -name prime256v1 -genkey -noout -out "$key_pem" 2>/dev/null
  priv_hex="$(openssl ec -in "$key_pem" -noout -text 2>/dev/null \
    | sed -n '/^priv:/,/^pub:/p' | sed '1d;$d' | tr -d ' \n:')"
  pub_hex="$(openssl ec -in "$key_pem" -noout -text 2>/dev/null \
    | sed -n '/^pub:/,/^ASN1 OID/p' | sed '1d;$d' | tr -d ' \n:')"
  rm -f "$key_pem"
  # OpenSSL left-pads a BIGNUM with an extra 00 byte when the MSB is set —
  # keep exactly the last 32 bytes (64 hex chars) of the raw scalar.
  if [[ ${#priv_hex} -gt 64 ]]; then priv_hex="${priv_hex: -64}"; fi
  while [[ ${#priv_hex} -lt 64 ]]; do priv_hex="0${priv_hex}"; done
  VAPID_PRIVATE_KEY="$(hex_to_base64url "$priv_hex")"
  VAPID_PUBLIC_KEY="$(hex_to_base64url "$pub_hex")"
}

generate_secrets() {
  : "${MONGO_ROOT_USER:=privos}"
  : "${MONGO_ROOT_PASSWORD:=$(rand_hex 32)}"
  : "${ADMIN_PASS:=$(rand_hex 24)}"
  : "${ADMIN_EMAIL:=admin@localhost}"
  : "${REG_TOKEN:=$(rand_hex 32)}"
  : "${SANDBOX_API_KEY:=$(rand_hex 32)}"
  : "${MINIO_ROOT_USER:=privos-root}"
  : "${MINIO_ROOT_PASSWORD:=$(rand_hex 32)}"
  : "${MINIO_ACCESS_KEY:=privos-$(rand_hex 6)}"
  : "${MINIO_SECRET_KEY:=$(rand_hex 32)}"
  : "${MINIO_BUCKET:=privos}"
  : "${WEAVIATE_ROOT_KEY:=$(rand_hex 32)}"
  : "${PRIVOS_DEPLOYMENT_ID:=$(rand_uuid)}"
  : "${VAPID_SUBJECT:=mailto:${ADMIN_EMAIL}}"
  if [[ -z "${VAPID_PUBLIC_KEY:-}" || -z "${VAPID_PRIVATE_KEY:-}" ]]; then
    generate_vapid_keypair
  fi
  # shellcheck disable=SC2034 # consumed indirectly via ENV_KEYS in write_env_file
  MONGO_URL="mongodb://${MONGO_ROOT_USER}:${MONGO_ROOT_PASSWORD}@mongo:27017/privos?replicaSet=rs0&authSource=admin&w=1"
  # shellcheck disable=SC2034 # consumed indirectly via ENV_KEYS in write_env_file
  MONGO_OPLOG_URL="mongodb://${MONGO_ROOT_USER}:${MONGO_ROOT_PASSWORD}@mongo:27017/local?replicaSet=rs0&authSource=admin&w=1"
  # shellcheck disable=SC2034 # consumed indirectly via ENV_KEYS in write_env_file
  MONGODB_URL="mongodb://${MONGO_ROOT_USER}:${MONGO_ROOT_PASSWORD}@mongo:27017/?replicaSet=rs0&authSource=admin&w=1"
}

write_mongo_keyfile() {
  local keyfile="$PRIVOS_DIR/secrets/mongo-keyfile"
  mongo_keyfile_content "$MONGO_ROOT_PASSWORD" > "$keyfile"
  chmod 0400 "$keyfile"
  chown 999:999 "$keyfile"
}

# ---------------------------------------------------------------------------
# .env rendering
# ---------------------------------------------------------------------------

env_quote() {
  local v="$1"
  printf "'%s'" "${v//\'/\'\\\'\'}"
}

# Exact inverse of env_quote(): strip the wrapping single quotes, then
# reverse the '\'' → ' substitution for any embedded single quotes. A naive
# strip-one-leading/trailing-quote (the previous implementation) corrupts any
# value containing a literal `'` on the next load — e.g. an operator-supplied
# ADMIN_EMAIL or ROOT_URL with a quote in it would silently mangle on
# --upgrade. No `eval` — this only ever runs against our own file format.
env_unquote() {
  local v="$1"
  if [[ "$v" == \'*\' ]]; then
    v="${v#\'}"
    v="${v%\'}"
    v="${v//\'\\\'\'/\'}"
  fi
  printf '%s' "$v"
}

load_existing_env() {
  local env_file="$PRIVOS_DIR/.env" key val
  [[ -f "$env_file" ]] || return 0
  while IFS='=' read -r key val; do
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [[ -n "${!key:-}" ]] && continue # invocation-time env already set — do not clobber
    val="$(env_unquote "$val")"
    printf -v "$key" '%s' "$val"
    export "${key?}"
  done < "$env_file"
}

write_env_file() {
  local dest="$1" key val tmp
  tmp="$(mktemp)"
  {
    echo "# Generated by install.sh — do not hand-edit while the stack is running;"
    echo "# re-run install.sh (or --upgrade) instead. Mode 0600: contains secrets."
    for key in "${ENV_KEYS[@]}"; do
      val="${!key:-}"
      printf '%s=%s\n' "$key" "$(env_quote "$val")"
    done
  } > "$tmp"
  install -m 0600 "$tmp" "$dest"
  rm -f "$tmp"
}

# ---------------------------------------------------------------------------
# Config resolution
# ---------------------------------------------------------------------------

resolve_config() {
  : "${PRIVOS_PROJECT:=$PROJECT_NAME}"
  : "${PRIVOS_NETWORK:=$NETWORK_NAME}"
  : "${PRIVOS_HUB_PORT:=$DEFAULT_HUB_PORT}"
  : "${PRIVOS_BOARD_PORT:=$DEFAULT_BOARD_PORT}"
  : "${PRIVOS_PROXY_PORT:=$DEFAULT_PROXY_PORT}"
  : "${PRIVOS_MINIO_PORT:=$DEFAULT_MINIO_PORT}"
  : "${PRIVOS_VM_PORT_RANGE:=$DEFAULT_VM_PORT_RANGE}"
  : "${PRIVOS_STACK_VERSION:=${VERSION_FLAG:-latest}}"
  : "${PRIVOS_MONGO_CACHE_GB:=1}" "${PRIVOS_MONGO_MEM:=1g}" "${PRIVOS_MONGO_CPUS:=2}"
  : "${PRIVOS_MINIO_MEM:=512m}" "${PRIVOS_MINIO_CPUS:=1}"
  : "${PRIVOS_HUB_MEM:=2g}" "${PRIVOS_HUB_CPUS:=2}"
  : "${PRIVOS_BOARD_MEM:=512m}" "${PRIVOS_BOARD_CPUS:=1}"
  : "${PRIVOS_PROXY_MEM:=512m}" "${PRIVOS_PROXY_CPUS:=1}"
  : "${PRIVOS_WEAVIATE_MEM:=2g}" "${PRIVOS_WEAVIATE_CPUS:=1}"
  : "${PRIVOS_LOCAL_RUNTIME_MEM:=256m}" "${PRIVOS_LOCAL_RUNTIME_CPUS:=1}"
  : "${SERVICE_USAGE_AUTHORIZATION_FAIL_CLOSED:=true}"
  : "${PRIVOS_LLM_PROVIDER:=byo}"
  : "${PRIVOS_WITH_KNOWLEDGE_VECTOR:=false}"
  : "${PRIVOS_WITH_LOCAL_RUNTIME:=false}"

  # PRIVOS_DIR is resolved and validated once in main() (validate_privos_dir)
  # before this function ever runs — do not re-derive it from DIR_FLAG here,
  # that would silently swap the validated/canonicalized value back for the
  # raw, unvalidated flag string.
  [[ -n "$URL_FLAG" ]] && PRIVOS_ROOT_URL="$URL_FLAG"
  [[ -n "$HUB_PORT_FLAG" ]] && PRIVOS_HUB_PORT="$HUB_PORT_FLAG"
  [[ -n "$VM_PORT_RANGE_FLAG" ]] && PRIVOS_VM_PORT_RANGE="$VM_PORT_RANGE_FLAG"
  [[ -n "$VERSION_FLAG" ]] && PRIVOS_STACK_VERSION="$VERSION_FLAG"
  [[ -n "$WITH_KNOWLEDGE_VECTOR_FLAG" ]] && PRIVOS_WITH_KNOWLEDGE_VECTOR="true"
  [[ -n "$WITH_LOCAL_RUNTIME_FLAG" ]] && PRIVOS_WITH_LOCAL_RUNTIME="true"

  : "${PRIVOS_ROOT_URL:=http://localhost:${PRIVOS_HUB_PORT}}"

  validate_port "$PRIVOS_HUB_PORT" "--hub-port/PRIVOS_HUB_PORT"
  validate_port "$PRIVOS_BOARD_PORT" "PRIVOS_BOARD_PORT"
  validate_port "$PRIVOS_PROXY_PORT" "PRIVOS_PROXY_PORT"
  validate_port "$PRIVOS_MINIO_PORT" "PRIVOS_MINIO_PORT"
}

prompt_sidecars() {
  # Only ever prompt on a genuinely fresh install (no prior .env). A re-run
  # or --upgrade keeps whatever was already persisted; an explicit
  # --with-knowledge-vector / --with-local-runtime flag always wins.
  [[ "$HAD_EXISTING_ENV" == "true" ]] && return 0
  [[ "$ASSUME_YES" == "true" || ! -t 0 ]] && return 0
  if [[ -z "$WITH_KNOWLEDGE_VECTOR_FLAG" ]]; then
    cat >&2 <<'EOF'

Enable the knowledge-vector sidecar (Weaviate)?
  Managed knowledge base / semantic search. Adds a Weaviate container,
  ~+2 GB RAM (raises the practical minimum from 4 GB to 8 GB).
EOF
    read -r -p "  Enable? [y/N] " ans || ans=""
    [[ "$ans" =~ ^[Yy] ]] && PRIVOS_WITH_KNOWLEDGE_VECTOR="true" || PRIVOS_WITH_KNOWLEDGE_VECTOR="false"
  fi
  if [[ -z "$WITH_LOCAL_RUNTIME_FLAG" ]]; then
    cat >&2 <<'EOF'

Enable the local-runtime sidecar?
  Run marketplace MCP apps as containers on THIS host instead of PrivOS's
  app cluster. Needs Docker socket access
  (TENANT_MCP_LOCAL_RUNTIME_DRIVER_ENABLED=true, dockerSocketGid from
  `stat -c %g /var/run/docker.sock`).
EOF
    read -r -p "  Enable? [y/N] " ans || ans=""
    [[ "$ans" =~ ^[Yy] ]] && PRIVOS_WITH_LOCAL_RUNTIME="true" || PRIVOS_WITH_LOCAL_RUNTIME="false"
  fi
}

finalize_sidecar_config() {
  if [[ "$PRIVOS_WITH_LOCAL_RUNTIME" == "true" ]]; then
    : "${PRIVOS_DOCKER_SOCKET_GID:=$(stat -c %g /var/run/docker.sock 2>/dev/null || true)}"
    [[ -n "$PRIVOS_DOCKER_SOCKET_GID" ]] || die "local-runtime is enabled but /var/run/docker.sock is not present — cannot resolve the docker socket group."
    if [[ -z "${PRIVOS_LOCAL_RUNTIME_ENDPOINT_HOSTS:-}" ]]; then
      if [[ -t 0 && "$ASSUME_YES" != "true" ]]; then
        read -r -p "local-runtime endpoint hostname allowlist (comma-separated): " PRIVOS_LOCAL_RUNTIME_ENDPOINT_HOSTS
      fi
      [[ -n "$PRIVOS_LOCAL_RUNTIME_ENDPOINT_HOSTS" ]] || die "local-runtime requires PRIVOS_LOCAL_RUNTIME_ENDPOINT_HOSTS (an explicit hostname allowlist) — set it in the environment or answer the prompt."
    fi
  fi
  local -a profiles=()
  [[ "$PRIVOS_WITH_KNOWLEDGE_VECTOR" == "true" ]] && profiles+=("knowledge-vector")
  [[ "$PRIVOS_WITH_LOCAL_RUNTIME" == "true" ]] && profiles+=("local-runtime")
  # shellcheck disable=SC2034 # consumed indirectly via ENV_KEYS in write_env_file
  if (( ${#profiles[@]} > 0 )); then
    COMPOSE_PROFILES="$(IFS=,; echo "${profiles[*]}")"
  else
    COMPOSE_PROFILES=""
  fi
}

# ---------------------------------------------------------------------------
# Stack lifecycle
# ---------------------------------------------------------------------------

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" --project-name "$PRIVOS_PROJECT" "$@"
}

ensure_network() {
  docker network inspect "$PRIVOS_NETWORK" >/dev/null 2>&1 && return 0
  docker network create "$PRIVOS_NETWORK" >/dev/null
  log "Created Docker network ${PRIVOS_NETWORK}"
}

install_docker_user_rules() {
  install -m 0755 "$PRIVOS_DIR/docker-user-rules.sh" /usr/local/sbin/privos-docker-user-rules.sh
  local ports="${PRIVOS_BOARD_PORT},${PRIVOS_PROXY_PORT},${PRIVOS_MINIO_PORT},${PRIVOS_VM_PORT_RANGE/-/:}"
  /usr/local/sbin/privos-docker-user-rules.sh "$ports" >/dev/null
}

wait_for_compose_healthy() {
  local service="$1" timeout_s="${2:-120}" waited=0 status
  while (( waited < timeout_s )); do
    status="$(compose ps --format '{{.Health}}' "$service" 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && return 0
    sleep 3
    waited=$(( waited + 3 ))
  done
  return 1
}

initiate_replica_set() {
  compose exec -T mongo mongosh --quiet --eval '
    try {
      rs.status().ok;
    } catch (e) {
      rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "mongo:27017" }] });
    }
  ' >/dev/null
}

run_minio_init() {
  compose run --rm minio-init
}

bring_up_stack() {
  compose pull
  compose up -d mongo redis minio
  wait_for_compose_healthy mongo 120 || die "mongo did not become healthy — inspect with: docker compose -f ${COMPOSE_FILE} logs mongo"
  initiate_replica_set
  wait_for_compose_healthy minio 60 || die "minio did not become healthy — inspect with: docker compose -f ${COMPOSE_FILE} logs minio"
  run_minio_init
  compose up -d
}

wait_for_stack_ready() {
  local deadline hub_ok=0 proxy_ok=0
  deadline=$(( $(date +%s) + STACK_READY_TIMEOUT_SEC ))
  while (( $(date +%s) < deadline )); do
    if (( hub_ok == 0 )) && curl -fsS -o /dev/null "http://127.0.0.1:${PRIVOS_HUB_PORT}/api/info" 2>/dev/null; then hub_ok=1; fi
    if (( proxy_ok == 0 )) && curl -fsS -o /dev/null "http://127.0.0.1:${PRIVOS_PROXY_PORT}/health" 2>/dev/null; then proxy_ok=1; fi
    (( hub_ok == 1 && proxy_ok == 1 )) && return 0
    sleep 5
  done
  (( hub_ok == 1 )) || log "hub did not become healthy within ${STACK_READY_TIMEOUT_SEC}s"
  (( proxy_ok == 1 )) || log "sandbox-proxy did not become healthy within ${STACK_READY_TIMEOUT_SEC}s"
  return 1
}

print_summary() {
  local code=""
  code="$(compose exec -T hub cat /var/lib/privos/self-hosted/license-request-code 2>/dev/null || true)"
  echo ""
  echo "PrivOS is ready."
  echo "  Hub:            ${PRIVOS_ROOT_URL}"
  echo "  Install dir:    ${PRIVOS_DIR}  (.env is mode 0600 — contains secrets, never printed here)"
  if [[ -n "$code" ]]; then
    echo "  License request code: ${code}"
    echo "  Activate at:    https://client.privos.io/self-hosted/activate#code=${code}"
  else
    echo "  License request code not yet available — check again shortly with:"
    echo "    docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} exec hub cat /var/lib/privos/self-hosted/license-request-code"
  fi
}

do_uninstall() {
  COMPOSE_FILE="$PRIVOS_DIR/compose.yml"
  ENV_FILE="$PRIVOS_DIR/.env"
  [[ -f "$COMPOSE_FILE" ]] || die "no install found at ${PRIVOS_DIR}"
  load_existing_env
  compose down --remove-orphans || true
  if [[ "$PURGE" == "true" ]]; then
    docker network rm "$PRIVOS_NETWORK" >/dev/null 2>&1 || true
    docker volume rm "${PRIVOS_PROJECT}-hub-lib" >/dev/null 2>&1 || true
    systemctl disable --now privos-restrict-sandbox-plane.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/privos-restrict-sandbox-plane.service /usr/local/sbin/privos-restrict-sandbox-plane.sh /usr/local/sbin/privos-docker-user-rules.sh
    systemctl daemon-reload >/dev/null 2>&1 || true
    rm -rf "${PRIVOS_DIR:?}"
    log "Uninstalled and purged all data."
  else
    log "Stopped. Data preserved at ${PRIVOS_DIR}. Re-run install.sh to restart, or add --purge to delete data."
  fi
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

main() {
  trap on_err ERR EXIT

  parse_args "$@"
  set_stage "resolving --dir"
  PRIVOS_DIR="${DIR_FLAG:-${PRIVOS_DIR:-$DEFAULT_DIR}}"
  PRIVOS_DIR="$(validate_privos_dir "$PRIVOS_DIR")"

  if [[ "$MODE" == "uninstall" ]]; then
    set_stage "uninstall"
    require_root
    PRIVOS_PROJECT="${PRIVOS_PROJECT:-$PROJECT_NAME}"
    PRIVOS_NETWORK="${PRIVOS_NETWORK:-$NETWORK_NAME}"
    do_uninstall
    exit 0
  fi

  set_stage "preflight"
  require_root
  warn_if_dev_signing_key
  detect_platform
  ensure_docker
  check_resources
  resolve_bundle_source
  HAD_EXISTING_ENV="false"
  [[ -f "$PRIVOS_DIR/.env" ]] && HAD_EXISTING_ENV="true"
  load_existing_env
  resolve_config
  prompt_sidecars
  finalize_sidecar_config

  set_stage "port conflict check"
  local -a requested_ports=("$PRIVOS_HUB_PORT" "$PRIVOS_BOARD_PORT" "$PRIVOS_PROXY_PORT" "$PRIVOS_MINIO_PORT")
  mapfile -t vm_ports < <(expand_port_range "$PRIVOS_VM_PORT_RANGE")
  requested_ports+=("${vm_ports[@]}")
  check_ports "${requested_ports[@]}" || exit 1

  set_stage "license acceptance"
  require_license_acceptance

  set_stage "creating directories"
  mkdir -p "$PRIVOS_DIR"/data/{mongo,minio,hub-uploads,sandbox-board,sandbox-proxy,sandbox-pool,weaviate,local-runtime-socket,local-runtime-state}
  mkdir -p "$PRIVOS_DIR"/secrets
  write_license_marker

  set_stage "fetching and verifying the bundle"
  fetch_bundle "$PRIVOS_DIR"
  verify_bundle_integrity "$PRIVOS_DIR"
  chmod 0644 "$PRIVOS_DIR/LICENSE" "$PRIVOS_DIR/NOTICE" "$PRIVOS_DIR/OPEN-SOURCE-NOTICES" \
    "$PRIVOS_DIR/rocketchat-upstream-files.txt" "$PRIVOS_DIR/TRADEMARK.md"

  COMPOSE_FILE="$PRIVOS_DIR/compose.yml"
  ENV_FILE="$PRIVOS_DIR/.env"

  set_stage "generating secrets"
  generate_secrets
  write_mongo_keyfile
  write_env_file "$ENV_FILE"

  set_stage "network + firewall setup"
  ensure_network
  chown -R 1001:1001 "$PRIVOS_DIR/data/sandbox-board" "$PRIVOS_DIR/data/sandbox-proxy" "$PRIVOS_DIR/data/sandbox-pool"
  install_docker_user_rules

  set_stage "bringing up the stack (docker compose)"
  bring_up_stack
  set_stage "waiting for hub + sandbox-proxy to become healthy"
  wait_for_stack_ready || die "stack did not become healthy in time — inspect with: docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} logs"
  print_summary
}

if [[ "$(resolve_script_path 2>/dev/null || true)" == "${0}" ]]; then
  main "$@"
fi
