#!/usr/bin/env bash
# PrivOS self-hosted installer.
#
#   curl -fsSL https://github.com/PrivOS-AI/privos/releases/latest/download/install.sh | sudo bash
#
# Installs hub + sandbox (mongo, redis, rustfs, board, proxy, VM pool) as a
# single-host Docker Compose stack. Idempotent: safe to re-run. See
# docs/self-hosted-install.md for the full model this implements.
#
# Flags: --version <tag> --dir <path> --url <root-url> --hub-port <port>
#        --vm-port-range <lo-hi> --yes --accept-license --upgrade --uninstall
#        [--purge] --with-knowledge-vector --without-app-cluster
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

# The bundle (compose.yml, versions.json, rustfs-init.sh, docker-user-rules.sh,
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
DEFAULT_RUSTFS_PORT=9000
DEFAULT_VM_PORT_RANGE="30000-30999"
MIN_RAM_MB=3800
MIN_DISK_KB=$(( 20 * 1024 * 1024 ))
MIN_DOCKER_MAJOR=24
PROJECT_NAME="privos"
NETWORK_NAME="privos-sandbox-net"
STACK_READY_TIMEOUT_SEC=600

BUNDLE_FILES=(compose.yml versions.json rustfs-init.sh docker-user-rules.sh LICENSE NOTICE OPEN-SOURCE-NOTICES rocketchat-upstream-files.txt TRADEMARK.md)
SIGNED_FILES=(compose.yml versions.json)
# Not directly minisig-signed, but versions.json's files{} block (itself
# covered by the versions.json signature) carries a sha256 for each of
# these — verify_bundle_integrity() checks both before either file is
# installed, mounted, or executed. rustfs-init.sh/docker-user-rules.sh run as
# root / with root-equivalent access (systemd unit + iptables; RustFS root
# creds in the rc container); LICENSE is hashed the same way so the text an
# operator accepts can never silently diverge from what was actually signed.
# NOTICE/OPEN-SOURCE-NOTICES/rocketchat-upstream-files.txt/TRADEMARK.md are
# on the same trust path for the same reason: NOTICE requires all five files
# to be passed on together, so none of them may be swapped after signing.
UNSIGNED_HASHED_FILES=(rustfs-init.sh docker-user-rules.sh LICENSE NOTICE OPEN-SOURCE-NOTICES rocketchat-upstream-files.txt TRADEMARK.md)
LICENSE_MARKER_FILE=".license-accepted"
LICENSE_VERSION="PCL-1.0"
MAX_PORT_RANGE_SPAN=5000
DANGEROUS_DIRS=(/ /root /home /usr /usr/local /etc /bin /sbin /lib /lib64 /var /boot /dev /proc /sys /opt /tmp /srv /mnt /media /run)

# .env keys, in the order they are written — must match env.template.
ENV_KEYS=(
  PRIVOS_DIR PRIVOS_PROJECT PRIVOS_NETWORK PRIVOS_STACK_VERSION PRIVOS_ROOT_URL PRIVOS_DEPLOYMENT_ID
  PRIVOS_HUB_PORT PRIVOS_BOARD_PORT PRIVOS_PROXY_PORT PRIVOS_RUSTFS_PORT PRIVOS_VM_PORT_RANGE
  MONGO_ROOT_USER MONGO_ROOT_PASSWORD MONGO_URL MONGO_OPLOG_URL MONGODB_URL
  PRIVOS_MONGO_CACHE_GB PRIVOS_MONGO_MEM PRIVOS_MONGO_CPUS
  RUSTFS_ROOT_USER RUSTFS_ROOT_PASSWORD RUSTFS_ACCESS_KEY RUSTFS_SECRET_KEY RUSTFS_BUCKET
  PRIVOS_RUSTFS_MEM PRIVOS_RUSTFS_CPUS
  ADMIN_PASS ADMIN_EMAIL REG_TOKEN VAPID_SUBJECT VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY SANDBOX_API_KEY
  SERVICE_USAGE_AUTHORIZATION_FAIL_CLOSED PRIVOS_SECRET_STORE_KEY
  PRIVOS_HUB_MEM PRIVOS_HUB_CPUS PRIVOS_BOARD_MEM PRIVOS_BOARD_CPUS PRIVOS_PROXY_MEM PRIVOS_PROXY_CPUS
  PRIVOS_LLM_PROVIDER ANTHROPIC_API_KEY OPENAI_API_KEY PRIVOS_LLM_BASE_URL
  PRIVOS_WITH_KNOWLEDGE_VECTOR PRIVOS_WEAVIATE_URL WEAVIATE_ROOT_KEY PRIVOS_WEAVIATE_MEM PRIVOS_WEAVIATE_CPUS
  PRIVOS_WITH_APP_CLUSTER PRIVOS_DOCKER_SOCKET_GID PRIVOS_APP_CLUSTER_BOOTSTRAP_TOKEN PRIVOS_APP_CLUSTER_MEM PRIVOS_APP_CLUSTER_CPUS
  PRIVOS_PUBLISHER_URL PRIVOS_PUBLISHER_BIND PRIVOS_PUBLISHER_PORT PRIVOS_PUBLISHER_MEM
  COMPOSE_PROFILES
)

# ---------------------------------------------------------------------------
# Logging — never print secret values.
# ---------------------------------------------------------------------------

log()  { printf '[privos-install] %s\n' "$*" >&2; }
die()  { printf '[privos-install] ERROR: %s\n' "$*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

# Hostname (no scheme, no userinfo, no port, no path) from an absolute http(s) URL;
# empty on anything without a scheme:// . Used to keep the publisher off the hub host.
url_hostname() {
  local u="$1"
  [[ "$u" == *"://"* ]] || { echo ""; return; }
  u="${u#*://}"; u="${u%%/*}"; u="${u#*@}"; u="${u%%:*}"
  echo "$u"
}

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
    write_diagnostics_bundle "$rc" || true
  fi
  exit "$rc"
}

# Support bundle on failure: system facts, docker state, and the last lines of
# each stack container's log. Deliberately EXCLUDES .env and secrets/. Goes to
# /tmp so it works even before PRIVOS_DIR exists. Best-effort, never fatal.
write_diagnostics_bundle() {
  local rc="$1" ts dir out c
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  dir="$(mktemp -d 2>/dev/null)" || return 0
  {
    echo "stage=${CURRENT_STAGE} exit=${rc} time=${ts}"
    echo "uname: $(uname -a)"; cat /etc/os-release 2>/dev/null
    echo "virt=$(systemd-detect-virt 2>/dev/null || echo n/a) systemd=${HAS_SYSTEMD:-?} wsl=${IS_WSL:-?} pkg=${HOST_PKG_MGR:-?}"
    echo "--- mem ---"; free -h 2>/dev/null
    echo "--- disk ---"; df -h "${PRIVOS_DIR:-/}" 2>/dev/null
    echo "--- ipv6 disabled ---"; sysctl -n net.ipv6.conf.all.disable_ipv6 2>/dev/null
    echo "--- selinux ---"; getenforce 2>/dev/null || echo n/a
  } > "$dir/system.txt" 2>&1
  if command -v docker >/dev/null 2>&1; then
    docker version > "$dir/docker-version.txt" 2>&1 || true
    docker ps -a > "$dir/docker-ps.txt" 2>&1 || true
    for c in $(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E "^${PRIVOS_PROJECT:-privos}-"); do
      docker inspect -f 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} restarts={{.RestartCount}} oom={{.State.OOMKilled}} exit={{.State.ExitCode}}' "$c" > "$dir/state-${c}.txt" 2>&1 || true
      docker logs --tail 80 "$c" > "$dir/log-${c}.txt" 2>&1 || true
    done
  fi
  out="/tmp/privos-install-diagnostics-${ts}.tar.gz"
  if tar -czf "$out" -C "$dir" . 2>/dev/null; then
    echo "[privos-install] Diagnostics written to ${out} (no .env/secrets) — attach it when asking for help." >&2
  fi
  rm -rf "$dir"
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
  --without-app-cluster      Opt out of the App Cluster (marketplace MCP-app
                            runtime; needs Docker socket access). ON by
                            default — see docs/self-hosted-install.md.
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
WITHOUT_APP_CLUSTER_FLAG=""
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
      --without-app-cluster) WITHOUT_APP_CLUSTER_FLAG="true"; shift ;;
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

# Environment facts other checks branch on. Set once here.
HAS_SYSTEMD="false"
HOST_PKG_MGR=""
IS_WSL="false"

detect_platform() {
  local os arch distro virt
  os="$(uname -s)"
  arch="$(uname -m)"
  [[ "$os" == "Linux" ]] || die "this installer supports Linux only (found: ${os})."
  # The published images are linux/amd64 only. Saying so up front beats a
  # cryptic "no matching manifest" from docker pull minutes later.
  case "$arch" in
    x86_64) ;;
    aarch64|arm64) die "unsupported architecture: ${arch} — the self-hosted images are currently published for x86_64 (amd64) only. arm64 is not available yet." ;;
    *) die "unsupported architecture: ${arch} (supported: x86_64)." ;;
  esac

  # shellcheck disable=SC1091  # /etc/os-release is absent at lint time; guarded by 2>/dev/null
  distro="$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-${ID:-unknown}}")"
  [[ -n "$distro" ]] || distro="unknown"
  virt="$(systemd-detect-virt 2>/dev/null || true)"
  command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]] && HAS_SYSTEMD="true"
  if grep -qiE 'microsoft.*wsl|wsl2' /proc/version 2>/dev/null; then IS_WSL="true"; fi

  # Package manager for host-tool auto-install (first match wins).
  for pm in apt-get dnf yum apk zypper; do
    command -v "$pm" >/dev/null 2>&1 && { HOST_PKG_MGR="$pm"; break; }
  done

  log "Platform: ${os} ${arch} · ${distro}${virt:+ · virt=${virt}}${HOST_PKG_MGR:+ · pkg=${HOST_PKG_MGR}}$([[ "$HAS_SYSTEMD" == "true" ]] || printf ' · no-systemd')"

  if [[ "$IS_WSL" == "true" ]]; then
    log "WARNING: running under WSL2. It is not a supported production host (networking,"
    log "systemd and disk-IO quirks); use a real Linux VM or server for anything durable."
  fi
  if [[ "$HAS_SYSTEMD" != "true" ]]; then
    log "WARNING: no systemd detected — the firewall backstop rules will apply now but"
    log "will NOT persist across reboots, and Docker cannot be auto-started here."
  fi
}

# Everything the trust chain and secret generation call: a stock Ubuntu/Debian
# image ships neither jq nor minisign, and a missing binary would otherwise
# surface as "signature verification FAILED" after the license was accepted.
require_host_tools() {
  local missing=() c
  for c in curl jq minisign openssl; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  (( ${#missing[@]} == 0 )) && return 0
  # Stock images ship neither jq nor minisign. We already run as root, so
  # auto-install through whichever package manager the host has, rather than
  # dying and making the operator hand-install mid-run. Best-effort: anything
  # still missing afterwards is a hard stop with the exact command.
  if [[ -n "$HOST_PKG_MGR" ]]; then
    log "Installing missing host tools via ${HOST_PKG_MGR}: ${missing[*]}"
    # Bound every install: a fresh cloud VM often has apt/dpkg locked by
    # cloud-init/unattended-upgrades on first boot, or a slow/unreachable
    # mirror — either makes a silenced apt-get look frozen for minutes.
    # DPkg::Lock::Timeout waits for the lock (bounded) instead of stalling;
    # `timeout` caps a dead mirror so we fall through to the manual-hint die().
    case "$HOST_PKG_MGR" in
      apt-get) timeout 300 apt-get update -qq -o DPkg::Lock::Timeout=120 >/dev/null 2>&1 || true
               DEBIAN_FRONTEND=noninteractive timeout 300 apt-get install -y -o DPkg::Lock::Timeout=120 "${missing[@]}" >/dev/null 2>&1 || true ;;
      dnf)     timeout 300 dnf install -y "${missing[@]}" >/dev/null 2>&1 || true ;;
      yum)     timeout 300 yum install -y "${missing[@]}" >/dev/null 2>&1 || true ;;
      apk)     timeout 300 apk add --no-cache "${missing[@]}" >/dev/null 2>&1 || true ;;
      zypper)  timeout 300 zypper --non-interactive install "${missing[@]}" >/dev/null 2>&1 || true ;;
    esac
    missing=()
    for c in curl jq minisign openssl; do
      command -v "$c" >/dev/null 2>&1 || missing+=("$c")
    done
  fi
  if (( ${#missing[@]} > 0 )); then
    local hint="install them and re-run"
    case "$HOST_PKG_MGR" in
      apt-get) hint="apt-get install -y ${missing[*]}" ;;
      dnf|yum) hint="${HOST_PKG_MGR} install -y ${missing[*]}   (minisign may need EPEL: ${HOST_PKG_MGR} install -y epel-release)" ;;
      apk)     hint="apk add ${missing[*]}" ;;
      zypper)  hint="zypper install ${missing[*]}" ;;
    esac
    die "missing host tools: ${missing[*]} — ${hint}, then re-run."
  fi
}

# Persist an IPv6-disable sysctl and apply it now.
disable_ipv6_persistent() {
  printf 'net.ipv6.conf.all.disable_ipv6=1\nnet.ipv6.conf.default.disable_ipv6=1\nnet.ipv6.conf.lo.disable_ipv6=1\n' \
    > /etc/sysctl.d/99-privos-disable-ipv6.conf 2>/dev/null || { log "could not write /etc/sysctl.d — skipping IPv6 disable"; return 0; }
  sysctl --system >/dev/null 2>&1 || true
  log "IPv6 disabled (persisted to /etc/sysctl.d/99-privos-disable-ipv6.conf)."
}

# Preflight: catch a host where IPv6 is advertised (DNS returns AAAA for the
# release host) but has NO working route to the internet — typical behind
# IPv4-only NAT / Hyper-V, where only link-local fe80 addresses exist. docker
# image pulls and apt then try IPv6 first and stall for minutes. Detect the
# REAL risk (AAAA present AND IPv6 egress fails), then ask (interactive) or warn
# (--yes) — never mutate host networking silently.
check_network_environment() {
  # Already disabled, or the tools to judge are absent → nothing to do.
  [[ "$(sysctl -n net.ipv6.conf.all.disable_ipv6 2>/dev/null || echo 0)" == "1" ]] && return 0
  command -v getent >/dev/null 2>&1 || return 0
  # No AAAA for the release host → resolvers won't try IPv6 → no stall risk.
  getent ahostsv6 github.com >/dev/null 2>&1 || return 0
  # AAAA exists — if IPv6 actually reaches it, IPv6 is fine; leave it alone.
  curl -6 -sS -m 5 -o /dev/null https://github.com 2>/dev/null && return 0

  log "IPv6 is enabled and DNS returns IPv6 (AAAA) records, but this host has NO"
  log "working IPv6 route to the internet (typical behind IPv4-only NAT). Docker"
  log "image pulls and apt can stall for minutes trying IPv6 before falling back."
  if [[ "$ASSUME_YES" != "true" && -r /dev/tty && -w /dev/tty ]]; then
    printf 'Disable IPv6 on this host now to avoid stalls? [Y/n] ' > /dev/tty
    local ans=""; read -r ans < /dev/tty || ans=""
    if [[ ! "$ans" =~ ^[Nn] ]]; then
      disable_ipv6_persistent
    else
      log "Leaving IPv6 enabled — if the image pull stalls, disable it and re-run."
    fi
  elif [[ "${PRIVOS_DISABLE_BROKEN_IPV6:-}" == "1" ]]; then
    disable_ipv6_persistent
  else
    log "WARNING: proceeding with broken IPv6. If the pull stalls, either re-run"
    log "with PRIVOS_DISABLE_BROKEN_IPV6=1, or disable IPv6 yourself:"
    log "  printf 'net.ipv6.conf.all.disable_ipv6=1\\nnet.ipv6.conf.default.disable_ipv6=1\\n' | sudo tee /etc/sysctl.d/99-privos-disable-ipv6.conf && sudo sysctl --system"
  fi
}

# Fail EARLY with the cause when the two hosts we depend on are unreachable,
# instead of a stalled/failed `docker pull` minutes in. ghcr answers 401 (an
# auth challenge) when reachable — that IS the success signal for a public pull.
check_registry_reachability() {
  local code
  code="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' https://ghcr.io/v2/ 2>/dev/null || echo 000)"
  [[ "$code" =~ ^(200|401)$ ]] || die "cannot reach ghcr.io (HTTP ${code}) — the images are pulled from there. Check DNS, outbound firewall (TCP 443) and any corporate proxy; Docker's daemon needs its OWN proxy config (https://docs.docker.com/engine/daemon/proxy/)."
  code="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' -I https://github.com 2>/dev/null || echo 000)"
  [[ "$code" =~ ^(200|301|302)$ ]] || die "cannot reach github.com (HTTP ${code}) — the bundle is downloaded from GitHub Releases. Check DNS / firewall / proxy."
  if [[ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}${http_proxy:-}${https_proxy:-}" ]]; then
    log "NOTE: a proxy is set in this shell. The Docker daemon does NOT inherit shell"
    log "proxy env — image pulls need it in the daemon config (systemd drop-in"
    log "docker.service.d/http-proxy.conf, or \"proxies\" in /etc/docker/daemon.json)."
  fi
}

# A skewed clock breaks TLS and time-bounded signature checks in confusing ways.
check_clock_skew() {
  local hdr remote now skew
  hdr="$(curl -sS -m 10 -I https://github.com 2>/dev/null | awk 'tolower($1)=="date:"{sub(/^[Dd]ate: /,""); print; exit}' | tr -d '\r')"
  [[ -n "$hdr" ]] || return 0
  remote="$(date -d "$hdr" +%s 2>/dev/null || true)"; [[ -n "$remote" ]] || return 0
  now="$(date +%s)"; skew=$(( now - remote )); (( skew < 0 )) && skew=$(( -skew ))
  if (( skew > 300 )); then
    log "WARNING: system clock is off by ~${skew}s vs github.com — TLS and signature"
    log "checks can fail. Fix: timedatectl set-ntp true  (or chrony/ntpdate), then re-run."
  fi
}

# SELinux Enforcing (RHEL/Fedora/Rocky): unlabeled bind mounts are denied, so
# containers cannot touch their data dirs. Warn with the two usual remedies.
check_selinux() {
  command -v getenforce >/dev/null 2>&1 || return 0
  [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]] || return 0
  log "WARNING: SELinux is Enforcing. Bind mounts under ${PRIVOS_DIR} may be denied and"
  log "the stack can fail to start. Remedies: relabel the data dir"
  log "  chcon -Rt svirt_sandbox_file_t ${PRIVOS_DIR}/data   (or setenforce 0 / SELINUX=permissive)."
}

# Containers left over from a previous or foreign install collide on
# container_name and make `compose up` fail with a name conflict (compose only
# adopts containers carrying ITS project label). Offer to remove them.
check_stale_stack() {
  local n label stale=()
  for n in mongo redis rustfs rustfs-init hub sandbox-board sandbox-proxy weaviate app-cluster; do
    n="${PRIVOS_PROJECT}-${n}"
    docker inspect "$n" >/dev/null 2>&1 || continue
    label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$n" 2>/dev/null)"
    [[ "$label" == "$PRIVOS_PROJECT" ]] || stale+=("$n")
  done
  (( ${#stale[@]} == 0 )) && return 0
  log "Found containers from a previous/foreign install that would collide on container_name:"
  log "  ${stale[*]}"
  if [[ "$ASSUME_YES" != "true" && -r /dev/tty && -w /dev/tty ]]; then
    printf 'Remove them so this install can proceed? [Y/n] ' > /dev/tty
    local ans=""; read -r ans < /dev/tty || ans=""
    if [[ ! "$ans" =~ ^[Nn] ]]; then
      docker rm -f "${stale[@]}" >/dev/null 2>&1 || true
      log "Removed stale containers."
      return 0
    fi
    die "stale containers left in place — remove them (docker rm -f ${stale[*]}) and re-run."
  fi
  die "stale containers would collide: ${stale[*]} — remove them (docker rm -f ${stale[*]}) and re-run, or run interactively to be prompted."
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

# Docker binary present but the daemon is not running is a DIFFERENT problem
# from "not installed" — try to start it, and if that fails say exactly that
# instead of telling the operator to install Docker they already have.
docker_daemon_up() { docker info >/dev/null 2>&1; }

ensure_docker() {
  if command -v docker >/dev/null 2>&1 && ! docker_daemon_up; then
    log "Docker is installed but the daemon is not running — starting it…"
    if [[ "$HAS_SYSTEMD" == "true" ]]; then systemctl start docker >/dev/null 2>&1 || true
    else service docker start >/dev/null 2>&1 || true; fi
    local waited=0
    until docker_daemon_up || (( waited >= 30 )); do sleep 2; waited=$(( waited + 2 )); done
    docker_daemon_up || die "Docker is installed but its daemon is not running and could not be started. Start it (systemctl start docker, or check 'journalctl -u docker') and re-run."
  fi
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

  # Prompt on the controlling terminal, not stdin: under the canonical
  # `curl … | sudo bash` stdin IS the piped script (never a TTY), but /dev/tty is
  # the real terminal (it is what sudo just read the password from). Fall back to
  # stdin when it is itself a TTY (a saved-file run), and only give up when there
  # is genuinely no terminal (CI / fully headless).
  local ans="" tty=""
  if [[ -r /dev/tty && -w /dev/tty ]]; then tty=/dev/tty
  elif [[ -t 0 ]]; then tty=/dev/stdin
  fi
  if [[ -n "$tty" ]]; then
    printf 'Accept the license? [y/N] ' > /dev/tty 2>/dev/null || printf 'Accept the license? [y/N] '
    read -r ans < "$tty" || ans=""
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
  # --connect-timeout bounds a black-holed route (a host with broken IPv6 would
  # otherwise hang ~130s per file on the default 300s connect timeout before
  # happy-eyeballs gives up); --retry rides out transient GitHub/CDN blips
  # instead of aborting the whole install on the first flaky byte.
  curl -fsSL --connect-timeout 20 --retry 3 --retry-delay 2 --retry-connrefused \
    "$url" -o "$dest" || die "failed to download ${url}"
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
# versions.json are). rustfs-init.sh and docker-user-rules.sh are instead
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
}

# Full bundle trust chain: minisig-verify the two signed files, then
# hash-verify every remaining bundle file against the (now-trusted)
# versions.json. Must run to completion before anything in $dir is used.
verify_bundle_integrity() {
  local dir="$1" f
  for f in "${SIGNED_FILES[@]}"; do
    verify_signature "$dir/$f"
  done
  for f in "${UNSIGNED_HASHED_FILES[@]}"; do
    verify_bundle_file_hash "$f" "$dir" "$dir/versions.json"
  done
  # One summary line instead of a per-file "sha256 OK:" for every hashed file
  # (a mismatch still fails loudly via die above).
  log "Bundle integrity verified (${#UNSIGNED_HASHED_FILES[@]} file hashes)."
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
  for name in hub sandbox-board sandbox-proxy rustfs; do
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

# ── Auto port fallback ──────────────────────────────────────────────────────
# On a FRESH install a DEFAULT service port already held by an unrelated process
# is moved to the next free port (announced) rather than aborting. Ports the
# operator set explicitly (flag / env / a prior .env on re-run) are never moved
# — they still hard-fail in check_ports so their intent is respected.

port_is_free() {  # free = nobody listening, or the listener is our own container
  local port="$1"
  [[ -z "${LISTEN_PID[$port]:-}" ]] && return 0
  port_already_ours "$port" && return 0
  return 1
}

pick_free_port() {  # $1 start; $2.. ports to also avoid (claimed this run)
  local p="$1"; shift; local -a avoid=("$@"); local a clash
  while (( p <= 65535 )); do
    if port_is_free "$p"; then
      clash=0; for a in "${avoid[@]}"; do [[ "$a" == "$p" ]] && { clash=1; break; }; done
      (( clash == 0 )) && { printf '%s' "$p"; return 0; }
    fi
    (( p++ ))
  done
  return 1
}

range_has_conflict() {  # $1 lo $2 hi — true if any port in [lo,hi] is foreign
  local lo="$1" hi="$2" p
  for (( p = lo; p <= hi; p++ )); do
    port_is_free "$p" || return 0
  done
  return 1
}

auto_resolve_port_conflicts() {
  collect_listeners
  local -a claimed=()
  local entry name expl var cur new
  for entry in "HUB:$PORT_EXPLICIT_HUB" "BOARD:$PORT_EXPLICIT_BOARD" \
               "PROXY:$PORT_EXPLICIT_PROXY" "RUSTFS:$PORT_EXPLICIT_RUSTFS"; do
    name="${entry%%:*}"; expl="${entry##*:}"
    var="PRIVOS_${name}_PORT"; cur="${!var}"
    claimed+=("$cur")
    (( expl == 1 )) && continue
    if ! port_is_free "$cur"; then
      new="$(pick_free_port "$cur" "${claimed[@]}")" \
        || die "no free port at or above ${cur} for ${name} — free one or pass a port flag/env."
      log "Port ${cur} (${name}) is in use — using ${new} instead (pin it with a flag/env to override)."
      printf -v "$var" '%s' "$new"
      claimed[${#claimed[@]} - 1]="$new"
    fi
  done
  if (( PORT_EXPLICIT_RANGE == 0 )); then
    local lo hi span shifted=0
    lo="${PRIVOS_VM_PORT_RANGE%-*}"; hi="${PRIVOS_VM_PORT_RANGE#*-}"; span=$(( hi - lo + 1 ))
    while range_has_conflict "$lo" "$hi"; do
      lo=$(( hi + 1 )); hi=$(( lo + span - 1 )); shifted=1
      (( hi > 65535 )) && die "no free ${span}-port window for the sandbox VM pool — pass --vm-port-range."
    done
    if (( shifted == 1 )); then
      log "Sandbox VM port range in use — using ${lo}-${hi} instead (override with --vm-port-range)."
      PRIVOS_VM_PORT_RANGE="${lo}-${hi}"
    fi
  fi
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
  : "${RUSTFS_ROOT_USER:=privos-root}"
  : "${RUSTFS_ROOT_PASSWORD:=$(rand_hex 32)}"
  : "${RUSTFS_ACCESS_KEY:=privos-$(rand_hex 6)}"
  # RustFS caps a service-account secret key at 8-40 chars (rustfs-init.sh runs
  # `rc admin service-account create ... <access-key> <secret-key>`); rand_hex 32
  # = 64 chars fails "secret key length should be between 8 and 40". 16 bytes = 32 hex chars.
  : "${RUSTFS_SECRET_KEY:=$(rand_hex 16)}"
  : "${RUSTFS_BUCKET:=privos}"
  : "${WEAVIATE_ROOT_KEY:=$(rand_hex 32)}"
  # Community bootstrap pairing (wire-contracts.md (b)) — the mutual HMAC
  # challenge secret between the hub and the App Cluster; generated
  # unconditionally (cheap, and PRIVOS_WITH_APP_CLUSTER can be flipped on
  # later without a second secrets pass). Never sent over the wire itself,
  # only HMAC(nonce) proofs.
  : "${PRIVOS_APP_CLUSTER_BOOTSTRAP_TOKEN:=$(rand_hex 32)}"
  # Encrypted-secret-store key (encrypted-secret-store.ts) — 32 raw bytes,
  # base64-encoded. Without it the hub falls back to a plaintext secret store
  # and refuses to pair an App Cluster at all (an RCE-grade credential is
  # never written in the clear). Generated unconditionally so the hub is
  # always pairing-capable.
  : "${PRIVOS_SECRET_STORE_KEY:=$(openssl rand -base64 32)}"
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

# One-way migration guard (V6): a MinIO-era .env has no path forward through  # no-minio-gate
# `--upgrade` — the store was renamed, not migrated, and object data is not
# carried over. Fail closed rather than silently booting a renamed stack
# against a directory an operator never touched.
refuse_upgrade_across_rename() {
  local env_file="$PRIVOS_DIR/.env"
  [[ -f "$env_file" ]] || return 0
  grep -qE '^MINIO_[A-Za-z_]*=' "$env_file" || return 0  # no-minio-gate: detect a MinIO-era env to refuse the upgrade
  cat >&2 <<'EOF'
[privos-install] ERROR: refusing --upgrade: this install's .env is from
before the MinIO -> RustFS rename (it still has MINIO_* keys). --upgrade
never migrates object data, so this refusal is not a data-loss regression —
it is the only prompt you would otherwise not get before the rename silently
breaks file upload. To move this install forward by hand:
  1. stop the stack:  docker compose -f compose.yml down
  2. in .env, copy the old values into the new keys, then delete the old ones:
       MINIO_ROOT_USER     -> RUSTFS_ROOT_USER
       MINIO_ROOT_PASSWORD -> RUSTFS_ROOT_PASSWORD
       MINIO_ACCESS_KEY    -> RUSTFS_ACCESS_KEY
       MINIO_SECRET_KEY    -> RUSTFS_SECRET_KEY
       MINIO_BUCKET        -> RUSTFS_BUCKET
       PRIVOS_MINIO_PORT   -> PRIVOS_RUSTFS_PORT
       PRIVOS_MINIO_MEM    -> PRIVOS_RUSTFS_MEM
       PRIVOS_MINIO_CPUS   -> PRIVOS_RUSTFS_CPUS
  3. mv data/minio data/rustfs  (object DATA is not migrated by this move —
     it only carries the bucket the old MinIO wrote; RustFS reads its own
     format from the same mount point)
  4. chown -R 10001:10001 data/rustfs
  5. re-run install.sh --upgrade
EOF
  exit 1
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
  # Record which ports were set explicitly (flag, env, or a prior .env loaded on
  # re-run) BEFORE defaulting — only defaulted ports are eligible for
  # auto-fallback; an explicit port that is busy still hard-fails in check_ports.
  PORT_EXPLICIT_HUB=0;   [[ -n "$HUB_PORT_FLAG" || -n "${PRIVOS_HUB_PORT:-}" ]] && PORT_EXPLICIT_HUB=1
  PORT_EXPLICIT_BOARD=0; [[ -n "${PRIVOS_BOARD_PORT:-}" ]] && PORT_EXPLICIT_BOARD=1
  PORT_EXPLICIT_PROXY=0; [[ -n "${PRIVOS_PROXY_PORT:-}" ]] && PORT_EXPLICIT_PROXY=1
  PORT_EXPLICIT_RUSTFS=0; [[ -n "${PRIVOS_RUSTFS_PORT:-}" ]] && PORT_EXPLICIT_RUSTFS=1
  PORT_EXPLICIT_RANGE=0; [[ -n "$VM_PORT_RANGE_FLAG" || -n "${PRIVOS_VM_PORT_RANGE:-}" ]] && PORT_EXPLICIT_RANGE=1
  : "${PRIVOS_HUB_PORT:=$DEFAULT_HUB_PORT}"
  : "${PRIVOS_BOARD_PORT:=$DEFAULT_BOARD_PORT}"
  : "${PRIVOS_PROXY_PORT:=$DEFAULT_PROXY_PORT}"
  : "${PRIVOS_RUSTFS_PORT:=$DEFAULT_RUSTFS_PORT}"
  : "${PRIVOS_VM_PORT_RANGE:=$DEFAULT_VM_PORT_RANGE}"
  : "${PRIVOS_STACK_VERSION:=${VERSION_FLAG:-latest}}"
  : "${PRIVOS_MONGO_CACHE_GB:=1}" "${PRIVOS_MONGO_MEM:=1g}" "${PRIVOS_MONGO_CPUS:=2}"
  : "${PRIVOS_RUSTFS_MEM:=512m}" "${PRIVOS_RUSTFS_CPUS:=1}"
  : "${PRIVOS_HUB_MEM:=2g}" "${PRIVOS_HUB_CPUS:=2}"
  : "${PRIVOS_BOARD_MEM:=512m}" "${PRIVOS_BOARD_CPUS:=1}"
  : "${PRIVOS_PROXY_MEM:=512m}" "${PRIVOS_PROXY_CPUS:=1}"
  : "${PRIVOS_WEAVIATE_MEM:=2g}" "${PRIVOS_WEAVIATE_CPUS:=1}"
  : "${PRIVOS_APP_CLUSTER_MEM:=256m}" "${PRIVOS_APP_CLUSTER_CPUS:=1}"
  : "${SERVICE_USAGE_AUTHORIZATION_FAIL_CLOSED:=true}"
  : "${PRIVOS_LLM_PROVIDER:=byo}"
  : "${PRIVOS_WITH_KNOWLEDGE_VECTOR:=false}"
  # The App Cluster is the community marketplace runtime — ON by default;
  # --without-app-cluster / PRIVOS_WITH_APP_CLUSTER=false opts out.
  : "${PRIVOS_WITH_APP_CLUSTER:=true}"

  # PRIVOS_DIR is resolved and validated once in main() (validate_privos_dir)
  # before this function ever runs — do not re-derive it from DIR_FLAG here,
  # that would silently swap the validated/canonicalized value back for the
  # raw, unvalidated flag string.
  [[ -n "$URL_FLAG" ]] && PRIVOS_ROOT_URL="$URL_FLAG"
  [[ -n "$HUB_PORT_FLAG" ]] && PRIVOS_HUB_PORT="$HUB_PORT_FLAG"
  [[ -n "$VM_PORT_RANGE_FLAG" ]] && PRIVOS_VM_PORT_RANGE="$VM_PORT_RANGE_FLAG"
  [[ -n "$VERSION_FLAG" ]] && PRIVOS_STACK_VERSION="$VERSION_FLAG"
  [[ -n "$WITH_KNOWLEDGE_VECTOR_FLAG" ]] && PRIVOS_WITH_KNOWLEDGE_VECTOR="true"
  [[ -n "$WITHOUT_APP_CLUSTER_FLAG" ]] && PRIVOS_WITH_APP_CLUSTER="false"

  # Move any busy DEFAULT ports before ROOT_URL is derived, so the summary URL
  # reflects the port the hub actually binds.
  auto_resolve_port_conflicts

  : "${PRIVOS_ROOT_URL:=http://localhost:${PRIVOS_HUB_PORT}}"

  validate_port "$PRIVOS_HUB_PORT" "--hub-port/PRIVOS_HUB_PORT"
  validate_port "$PRIVOS_BOARD_PORT" "PRIVOS_BOARD_PORT"
  validate_port "$PRIVOS_PROXY_PORT" "PRIVOS_PROXY_PORT"
  validate_port "$PRIVOS_RUSTFS_PORT" "PRIVOS_RUSTFS_PORT"
}

prompt_sidecars() {
  # Only ever prompt on a genuinely fresh install (no prior .env). A re-run
  # or --upgrade keeps whatever was already persisted; an explicit
  # --with-knowledge-vector / --without-app-cluster flag always wins.
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
  # App Cluster is ON by default (it is the marketplace runtime) — this is
  # an acknowledgement prompt, not an opt-in one: only an explicit "n"
  # disables it. --without-app-cluster skips this prompt entirely.
  if [[ -z "$WITHOUT_APP_CLUSTER_FLAG" ]]; then
    cat >&2 <<'EOF'

The App Cluster (community marketplace runtime) is enabled by default.
  Runs marketplace MCP apps as containers on THIS host, over a dial-out
  tunnel to the hub — no inbound port. Needs Docker socket access, which is
  root-equivalent on this host (no-new-privileges, all capabilities dropped).
EOF
    read -r -p "  Continue with Docker socket access enabled? [Y/n] " ans || ans=""
    [[ "$ans" =~ ^[Nn] ]] && PRIVOS_WITH_APP_CLUSTER="false" || PRIVOS_WITH_APP_CLUSTER="true"
  fi
}

finalize_sidecar_config() {
  if [[ "$PRIVOS_WITH_APP_CLUSTER" == "true" ]]; then
    : "${PRIVOS_DOCKER_SOCKET_GID:=$(stat -c %g /var/run/docker.sock 2>/dev/null || true)}"
    [[ -n "$PRIVOS_DOCKER_SOCKET_GID" ]] || die "the App Cluster is enabled but /var/run/docker.sock is not present — cannot resolve the docker socket group. Pass --without-app-cluster to opt out."
  fi
  local -a profiles=()
  [[ "$PRIVOS_WITH_KNOWLEDGE_VECTOR" == "true" ]] && profiles+=("knowledge-vector")
  [[ "$PRIVOS_WITH_APP_CLUSTER" == "true" ]] && profiles+=("app-cluster")
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

# MANAGED-broker root (McpBrokerManager) for the App Cluster's outbound
# node-identity attestation — copied from the fleet app-node recipe
# (infra/setup-app-node.sh). /run is tmpfs, so a tmpfiles.d unit is needed to
# recreate this directory on every boot; without it the broker root (and the
# app-cluster container that bind-mounts it) never comes back after a reboot.
install_mcp_broker_root() {
  install -d -o 1000 -g 1000 -m 0700 /run/privos/mcp-broker
  install -m 0644 /dev/stdin /etc/tmpfiles.d/privos-mcp-broker.conf <<'EOF'
d /run/privos/mcp-broker 0700 1000 1000 -
EOF
  if command -v systemd-tmpfiles >/dev/null 2>&1; then
    systemd-tmpfiles --create /etc/tmpfiles.d/privos-mcp-broker.conf
  else
    log "WARNING: systemd-tmpfiles not found — /run/privos/mcp-broker will not be"
    log "recreated automatically after a reboot; the App Cluster will fail to start"
    log "until this directory exists again (re-run install.sh to recreate it)."
  fi
}

install_docker_user_rules() {
  install -m 0755 "$PRIVOS_DIR/docker-user-rules.sh" /usr/local/sbin/privos-docker-user-rules.sh
  local ports="${PRIVOS_BOARD_PORT},${PRIVOS_PROXY_PORT},${PRIVOS_RUSTFS_PORT},${PRIVOS_VM_PORT_RANGE/-/:}"
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
  # mongod runs with --keyFile, so auth is enforced, and the entrypoint already
  # created the MONGO_INITDB_ROOT_* user during its init phase — which closes
  # the localhost exception. replSetInitiate therefore MUST authenticate as
  # root (an unauthenticated mongosh gets "requires authentication"). Expand the
  # credentials inside the container (they live there as MONGO_INITDB_ROOT_*),
  # never on the host command line, so they never reach the host's process list.
  # shellcheck disable=SC2016  # $ expands inside the mongo container, not the host shell
  compose exec -T mongo sh -c '
    mongosh --quiet \
      -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" \
      --authenticationDatabase admin \
      --eval "try { rs.status().ok } catch (e) { rs.initiate({ _id: \"rs0\", members: [{ _id: 0, host: \"mongo:27017\" }] }) }"
  ' >/dev/null
}

# ---------------------------------------------------------------------------
# Driver-removal guard (D4) — this compose bundle no longer ships
# local-runtime-driver (or its Hub-side unix-socket transport), so refuse to
# proceed while any installation is still bound to a NON-tunnel App Cluster
# row: only rows this phase creates carry connection:'tunnel', so any other
# shape predates it and would be stranded by the removal. Runs only on a
# re-run of an EXISTING install (a fresh install has no prior mcp_apps data
# to strand) and only when mongo is already up. Fails CLOSED: a query error
# blocks the install rather than silently proceeding blind.
# ---------------------------------------------------------------------------
guard_local_runtime_installations() {
  # shellcheck disable=SC2016  # $ expands inside the mongo container, not the host shell
  compose exec -T mongo sh -c '
    mongosh --quiet \
      -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" \
      --authenticationDatabase admin \
      --eval "
        const _db = db.getSiblingDB(\"privos\");
        const bound = _db.mcp_apps.aggregate([
          { \$match: { localRuntimeClusterId: { \$exists: true, \$ne: null } } },
          { \$lookup: { from: \"app_clusters\", localField: \"localRuntimeClusterId\", foreignField: \"_id\", as: \"c\" } },
          { \$match: { \$or: [ { c: { \$size: 0 } }, { \"c.0.connection\": { \$ne: \"tunnel\" } } ] } },
          { \$project: { _id: 1, name: 1 } }
        ]).toArray();
        print(JSON.stringify(bound));
      "
  '
}

check_local_runtime_installations() {
  [[ "$HAD_EXISTING_ENV" == "true" ]] || return 0
  command -v jq >/dev/null 2>&1 || die "jq is required to check for existing local-runtime installations before this upgrade — install it and re-run."
  local out rc json count
  out="$(guard_local_runtime_installations 2>&1)"
  rc=$?
  (( rc == 0 )) || die "could not check for existing local-runtime installations before this upgrade — refusing to proceed blind. mongo output: ${out}"
  # mongosh may print banner/warning lines before the eval's JSON output —
  # take the last line that looks like a JSON array. No fallback to "[]" here
  # on purpose: an output with no recognizable JSON array is itself a signal
  # something is wrong (mongosh format change, truncated output, ...) and
  # must fail closed, not be silently read as "nothing bound".
  json="$(printf '%s\n' "$out" | grep -E '^\[' | tail -1)"
  [[ -n "$json" ]] || die "could not parse the local-runtime installation check output — refusing to proceed blind (raw: ${out})"
  count="$(printf '%s' "$json" | jq 'length' 2>/dev/null || true)"
  [[ "$count" =~ ^[0-9]+$ ]] || die "could not parse the local-runtime installation check output — refusing to proceed blind (raw: ${json})"
  if (( count > 0 )); then
    log "Refusing to upgrade: ${count} installation(s) are still bound to a non-tunnel local-runtime cluster:"
    printf '%s' "$json" | jq -r '.[] | "  - " + (.name // "?") + " (" + (.["_id"] | tostring) + ")"' >&2
    die "uninstall the app(s) listed above while local-runtime-driver is still present (this install has not yet removed it), then re-run install.sh."
  fi
  log "No installations bound to a non-tunnel local-runtime cluster — safe to remove local-runtime-driver."
}

bring_up_stack() {
  compose pull
  compose up -d mongo redis rustfs
  wait_for_compose_healthy mongo 120 || die "mongo did not become healthy — inspect with: docker compose -f ${COMPOSE_FILE} logs mongo"
  initiate_replica_set
  check_local_runtime_installations
  wait_for_compose_healthy rustfs 60 || die "rustfs did not become healthy — inspect with: docker compose -f ${COMPOSE_FILE} logs rustfs"
  # rustfs-init runs once here: `compose up -d` starts it via its dependents'
  # `service_completed_successfully` conditions after rustfs is healthy. A prior
  # explicit `compose run --rm rustfs-init` made it run twice per install.
  compose up -d
}

wait_for_stack_ready() {
  local deadline hub_ok=0 proxy_ok=0
  deadline=$(( $(date +%s) + STACK_READY_TIMEOUT_SEC ))
  # The hub (Meteor) can take a few minutes to boot; print live dots so the wait
  # never looks like a hang, and note the proxy coming up separately.
  printf '  Hub is booting (Meteor — up to %ss); this is normal' "$STACK_READY_TIMEOUT_SEC"
  while (( $(date +%s) < deadline )); do
    if (( hub_ok == 0 )) && curl -fsS -o /dev/null "http://127.0.0.1:${PRIVOS_HUB_PORT}/api/info" 2>/dev/null; then
      hub_ok=1; printf ' [hub up]'
    fi
    if (( proxy_ok == 0 )) && curl -fsS -o /dev/null "http://127.0.0.1:${PRIVOS_PROXY_PORT}/health" 2>/dev/null; then
      proxy_ok=1; printf ' [proxy up]'
    fi
    (( hub_ok == 1 && proxy_ok == 1 )) && { printf ' ready.\n'; return 0; }
    printf '.'
    sleep 5
  done
  printf '\n'
  (( hub_ok == 1 )) || log "hub did not become healthy within ${STACK_READY_TIMEOUT_SEC}s"
  (( proxy_ok == 1 )) || log "sandbox-proxy did not become healthy within ${STACK_READY_TIMEOUT_SEC}s"
  return 1
}

# An upgrade re-runs against the .env of the previous install, whose
# PRIVOS_STACK_VERSION names the tag that install was pinned to. compose.yml
# pins every image by digest, so the pull is right either way, but the tag is
# what operators (and `docker ps`) read — take it from the verified bundle
# unless --version pinned one explicitly.
adopt_bundle_stack_version() {
  local dir="$1" bundle_version=""
  [[ -n "$VERSION_FLAG" ]] && return 0
  bundle_version="$(sed -n 's/^[[:space:]]*"stackVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$dir/versions.json" | head -n1)"
  [[ -n "$bundle_version" ]] || return 0
  if [[ "$PRIVOS_STACK_VERSION" != "$bundle_version" ]]; then
    log "Stack version: ${PRIVOS_STACK_VERSION} -> ${bundle_version} (from the verified bundle)"
    PRIVOS_STACK_VERSION="$bundle_version"
  fi
}

read_request_code() {  # echoes the code (or empty); never fails the caller
  { compose exec -T hub cat /var/lib/privos/self-hosted/license-request-code 2>/dev/null || true; } | tr -d '\r\n'
}

read_license_status() {  # echoes the raw license-status JSON (or empty)
  { compose exec -T hub cat /var/lib/privos/self-hosted/license-status 2>/dev/null || true; } | tr -d '\r\n'
}

print_ready() {
  echo ""
  echo "PrivOS is ready."
  echo "  Hub:            ${PRIVOS_ROOT_URL}"
  echo "  Install dir:    ${PRIVOS_DIR}  (.env is mode 0600 — contains secrets, never printed here)"
  echo ""
  echo "  Reach it locally at ${PRIVOS_ROOT_URL}. To serve it on a public domain,"
  echo "  put your own reverse proxy in front (nginx, Apache, or a Cloudflare"
  echo "  tunnel) — the hub binds ${PRIVOS_ROOT_URL} only."
  echo ""
  local pub_port="${PRIVOS_PUBLISHER_PORT:-8558}" pub_bind="${PRIVOS_PUBLISHER_BIND:-127.0.0.1}"
  if [[ -n "${PRIVOS_PUBLISHER_URL:-}" ]]; then
    echo "  Publisher:      ${PRIVOS_PUBLISHER_URL}  (published-files renderer)"
    echo "                  Point your reverse proxy/tunnel for that host at ${pub_bind}:${pub_port}."
  else
    echo "  Publisher:      http://${pub_bind}:${pub_port}  (published-files renderer — LOCAL only)"
    echo "                  Published files stay unreachable until you expose it. To turn it on:"
    echo "                    1. Pick a SEPARATE hostname (e.g. publish.example.com) — never the"
    echo "                       hub host: the publisher renders uploaded HTML in a sandboxed origin,"
    echo "                       and sharing the hub origin would break that isolation (install refuses it)."
    echo "                    2. Front ${pub_bind}:${pub_port} with your reverse proxy (nginx/Caddy) or a"
    echo "                       Cloudflare tunnel + TLS — same as you did for the hub."
    echo "                    3. Set PRIVOS_PUBLISHER_URL=https://publish.example.com in ${PRIVOS_DIR}/.env"
    echo "                       and re-run install.sh (or 'docker compose up -d') so the hub shows the link."
    echo "                  Full example (nginx + Cloudflare tunnel): docs/self-hosted-install.md"
  fi
}

# Non-interactive summary (--yes, or no controlling terminal): print readiness
# plus the request code + activate URL so the operator can finish activation
# later, out of band.
print_summary() {
  local code status; code="$(read_request_code)"; status="$(read_license_status)"
  print_ready
  echo ""
  if [[ "$status" == *'"status":"issued"'* ]]; then
    echo "  License:        activated (self-hosted licence already applied — nothing to do)"
  elif [[ -n "$code" ]]; then
    echo "  License request code: ${code}"
    echo "  Activate at:    https://client.privos.io/self-hosted/activate#code=${code}"
  else
    echo "  License request code not yet available — check again shortly with:"
    echo "    docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} exec hub cat /var/lib/privos/self-hosted/license-request-code"
  fi
}

# Best-effort: offer to copy the code to the clipboard when a clipboard tool is
# present (desktop). Headless servers usually have none — then it is a no-op
# with a note. Reads a single keypress from the controlling terminal ($1).
offer_clipboard_copy() {
  local text="$1" tty="$2" copier="" key=""
  if command -v pbcopy >/dev/null 2>&1; then copier="pbcopy"
  elif command -v wl-copy >/dev/null 2>&1; then copier="wl-copy"
  elif command -v xclip >/dev/null 2>&1; then copier="xclip -selection clipboard"
  fi
  if [[ -z "$copier" ]]; then
    echo "  (No clipboard tool detected — copy the code above manually.)" >"$tty"
    return 0
  fi
  printf '  Press [c] to copy the code, or any other key to continue… ' >"$tty"
  read -rsn1 key <"$tty" || key=""
  printf '\n' >"$tty"
  if [[ "$key" == "c" || "$key" == "C" ]]; then
    if printf '%s' "$text" | $copier >/dev/null 2>&1; then echo "  Copied to clipboard." >"$tty"
    else echo "  Could not access the clipboard — copy the code manually." >"$tty"; fi
  fi
}

# Interactive activation (a controlling terminal is present and NOT --yes):
# wait for the request code, let the operator copy it and activate online, then
# poll the hub's activation status until issued (≤30 min, Ctrl-C skips), show
# who it activated as, and only then print readiness.
interactive_activation() {
  # PRIVOS_ACTIVATION_TTY is a test-only override; production uses /dev/tty.
  local tty="${PRIVOS_ACTIVATION_TTY:-/dev/tty}" code="" waited=0
  printf 'Waiting for the license request code' >"$tty"
  while (( waited < 120 )); do
    code="$(read_request_code)"
    [[ -n "$code" ]] && break
    sleep 3 || true; waited=$(( waited + 3 )); printf '.' >"$tty"
  done
  printf '\n' >"$tty"
  if [[ -z "$code" ]]; then
    echo "  License request code not ready yet — falling back to the non-interactive summary." >"$tty"
    print_summary
    return 0
  fi

  {
    echo ""
    echo "  ┌─ License request code ────────────────────────────────"
    echo "  │   ${code}"
    echo "  └───────────────────────────────────────────────────────"
    echo ""
    echo "  Activate this deployment:"
    echo "    1. Open   https://client.privos.io/self-hosted/activate#code=${code}"
    echo "    2. Sign in (or create a free PrivOS account)."
    echo "    3. Choose your plan and complete activation."
    echo ""
  } >"$tty"
  offer_clipboard_copy "$code" "$tty"

  echo "" >"$tty"
  echo "  Waiting for activation to complete (up to 30 min). Press Ctrl-C to skip and finish later." >"$tty"
  local deadline status_json status_kind="" skipped=0
  deadline=$(( $(date +%s) + 1800 ))
  trap 'skipped=1' INT
  while (( $(date +%s) < deadline )); do
    status_json="$(read_license_status)"
    status_kind="$(printf '%s' "$status_json" | jq -r '.status // empty' 2>/dev/null || true)"
    [[ "$status_kind" == "issued" ]] && break
    sleep 10 || true
    (( skipped == 1 )) && break
    printf '.' >"$tty"
  done
  trap - INT
  printf '\n' >"$tty"

  if [[ "$status_kind" == "issued" ]]; then
    local email ws
    email="$(printf '%s' "$status_json" | jq -r '.ownerEmail // empty' 2>/dev/null || true)"
    ws="$(printf '%s' "$status_json" | jq -r '.workspaceName // empty' 2>/dev/null || true)"
    echo "  ✓ Activated${email:+ — ${email}}${ws:+ (workspace: ${ws})}" >"$tty"
    print_ready
  else
    echo "  Activation not completed yet — the hub keeps polling in the background." >"$tty"
    echo "  Finish anytime at https://client.privos.io/self-hosted/activate#code=${code}" >"$tty"
    print_ready
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
  require_host_tools
  check_network_environment
  check_registry_reachability
  check_clock_skew
  check_selinux
  ensure_docker
  check_resources
  resolve_bundle_source
  HAD_EXISTING_ENV="false"
  [[ -f "$PRIVOS_DIR/.env" ]] && HAD_EXISTING_ENV="true"
  [[ "$MODE" == "upgrade" ]] && refuse_upgrade_across_rename
  load_existing_env
  resolve_config
  prompt_sidecars
  finalize_sidecar_config

  set_stage "publisher url check"
  # The publisher renders arbitrary uploaded HTML in a sandboxed origin; hosting it
  # on the hub's own host would defeat that isolation (cookies are not port-scoped),
  # so a publisher URL on the ROOT_URL host is refused.
  if [[ -n "${PRIVOS_PUBLISHER_URL:-}" ]]; then
    local pub_host root_host
    pub_host="$(url_hostname "$PRIVOS_PUBLISHER_URL")"
    root_host="$(url_hostname "$PRIVOS_ROOT_URL")"
    [[ -n "$pub_host" ]] || { echo "PRIVOS_PUBLISHER_URL is not a valid URL: ${PRIVOS_PUBLISHER_URL}" >&2; exit 1; }
    if [[ "${pub_host,,}" == "${root_host,,}" ]]; then
      echo "PRIVOS_PUBLISHER_URL host (${pub_host}) must differ from the hub host (${root_host}) —" >&2
      echo "the publisher renders untrusted HTML in a sandboxed origin; front it on a separate hostname." >&2
      exit 1
    fi
  fi

  set_stage "port conflict check"
  local -a requested_ports=("$PRIVOS_HUB_PORT" "$PRIVOS_BOARD_PORT" "$PRIVOS_PROXY_PORT" "$PRIVOS_RUSTFS_PORT" "${PRIVOS_PUBLISHER_PORT:-8558}")
  mapfile -t vm_ports < <(expand_port_range "$PRIVOS_VM_PORT_RANGE")
  requested_ports+=("${vm_ports[@]}")
  check_ports "${requested_ports[@]}" || exit 1

  set_stage "license acceptance"
  require_license_acceptance

  set_stage "creating directories"
  mkdir -p "$PRIVOS_DIR"/data/{mongo,rustfs,hub-uploads,hub-marketplace/apps,hub-lib,sandbox-board,sandbox-proxy,sandbox-pool,weaviate,app-cluster-state}
  mkdir -p "$PRIVOS_DIR"/secrets
  [[ "$PRIVOS_WITH_APP_CLUSTER" == "true" ]] && install_mcp_broker_root
  write_license_marker

  set_stage "fetching and verifying the bundle"
  fetch_bundle "$PRIVOS_DIR"
  verify_bundle_integrity "$PRIVOS_DIR"
  adopt_bundle_stack_version "$PRIVOS_DIR"
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
  # RustFS runs as uid/gid 10001 in its official image (compose.yml `user:`).
  chown 10001:10001 "$PRIVOS_DIR/data/rustfs"
  chown -R 1001:1001 "$PRIVOS_DIR/data/sandbox-board" "$PRIVOS_DIR/data/sandbox-proxy" "$PRIVOS_DIR/data/sandbox-pool"
  # Hub (uid 1001) writes uploads and marketplace artifacts; the driver reads
  # apps/ as uid 1001 too and requires 0750 on it (compose-ssh-driver parity).
  chown 1001:1001 "$PRIVOS_DIR/data/hub-uploads" "$PRIVOS_DIR/data/hub-marketplace" "$PRIVOS_DIR/data/hub-marketplace/apps"
  chmod 0750 "$PRIVOS_DIR/data/hub-marketplace/apps"
  # hub-lib holds the hub identity keypair + self-hosted license code/status;
  # the hub (uid 1001) must be able to mkdir under it. 0700 — private to the hub.
  chown 1001:1001 "$PRIVOS_DIR/data/hub-lib"
  chmod 0700 "$PRIVOS_DIR/data/hub-lib"
  # The official node:20-alpine image's built-in "node" user is uid/gid 1000
  # — app-cluster (Dockerfile: `USER node`) must be able to write its state
  # dir (credential file, temp artifact chunks) there.
  chown 1000:1000 "$PRIVOS_DIR/data/app-cluster-state"
  install_docker_user_rules

  set_stage "bringing up the stack (docker compose)"
  check_stale_stack
  bring_up_stack
  set_stage "waiting for hub + sandbox-proxy to become healthy"
  wait_for_stack_ready || die "stack did not become healthy in time — inspect with: docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} logs"

  # Interactive activation only when NOT --yes and a controlling terminal is
  # reachable (works under `curl | bash`, where stdin is the pipe but /dev/tty
  # is the real terminal). Otherwise print the non-interactive summary.
  if [[ "$ASSUME_YES" != "true" && -r /dev/tty && -w /dev/tty ]]; then
    set_stage "license activation"
    interactive_activation
  else
    print_summary
  fi
}

# Run main unless the file is being *sourced* (tests/ source it to exercise
# individual functions). `(return)` succeeds only in a sourced context, so this
# correctly runs main for direct execution AND for the canonical
# `curl ... | sudo bash -s -- ...` (piped stdin), where $0 is "bash" but
# BASH_SOURCE[0] is "main" on bash 5 — a mismatch that made the old
# `resolve_script_path == $0` guard skip main entirely and exit doing nothing.
if ! (return 0 2>/dev/null); then
  main "$@"
fi
