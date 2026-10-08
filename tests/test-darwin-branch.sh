#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2030,SC2031,SC2034,SC2329 # stub scripts are written with literal $vars; variables are read by the sourced install.sh
# Exercises install.sh's macOS / Docker Desktop branch end to end on any host:
# PRIVOS_HOST_OS (or a stubbed `uname`) selects the branch, and stubs for
# docker, open, sw_vers, minisign and every root-only command stand in for the
# real tools and log what they were asked to do. Asserts the contract:
#   - runs as the user (root is refused), default dir $HOME/.privos
#   - every compose call carries compose.desktop.yml
#   - Linux-only steps (tmpfiles, DOCKER-USER rules, chown, SELinux, IPv6
#     sysctl, sudo) never run, and no data/ directory is created
#   - the overlay is signature- and hash-verified
#   - an arm64 engine needs linux/arm64 in every image's `platforms`
#   - Desktop not running -> `open`, wait; not installed -> download URL
#   - uninstall --purge removes volumes, networks and the install dir
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SELF_DIR/helpers.sh"
# shellcheck source=/dev/null
source "$SELF_DIR/../install.sh"
set +e

for tool in jq openssl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "# SKIP: ${tool} not installed"
    exit 0
  fi
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
STUB_DIR="$TMP/stubs"
BIN="$TMP/bin"
mkdir -p "$STUB_DIR" "$BIN" "$TMP/home/Library/Group Containers/group.com.docker" "$TMP/FakeDocker.app"
REAL_UNAME="$(command -v uname)"
export STUB_DIR REAL_UNAME
export HOME="$TMP/home"
export PRIVOS_DOCKER_DESKTOP_APP="$TMP/FakeDocker.app"
ORIG_PATH="$PATH"

# --- stubs -------------------------------------------------------------------

cat > "$BIN/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/docker.log"
case "${1:-}" in
  info)
    [[ -f "$STUB_DIR/daemon-down" ]] && exit 1
    case "$*" in
      *Architecture*) echo "${STUB_ARCH:-x86_64}" ;;
      *MemTotal*) echo "${STUB_MEM:-8589934592}" ;;
    esac ;;
  version)
    case "$*" in
      *APIVersion*) echo "${STUB_API:-1.47}" ;;
      *Server.Version*) echo "27.3.1" ;;
    esac ;;
  context) echo "${STUB_CONTEXT:-desktop-linux}" ;;
  compose)
    if [[ "${2:-}" == "version" ]]; then
      case "$*" in *--short*) echo "${STUB_COMPOSE_VER:-v2.29.1-desktop.1}" ;; *) echo "Docker Compose version v2.29.1-desktop.1" ;; esac
      exit 0
    fi
    case "$*" in
      *"ps --format"*) echo "healthy" ;;
      *"exec -T mongo"*) echo "[]" ;;
      *license-request-code*) echo "PRV-TEST-CODE" ;;
    esac ;;
  network) [[ "${2:-}" == "inspect" ]] && exit 1 ;;
  inspect) exit 1 ;;
  volume) [[ "${2:-}" == "ls" ]] && printf 'privos-mongo\nprivos-sandbox-pool\n' ;;
  ps) echo "agent-vm-1" ;;
  run)
    case "$*" in
      *"--entrypoint stat"*) [[ "${STUB_SOCK_GID:-2375}" == "fail" ]] && exit 1; echo "${STUB_SOCK_GID:-2375}" ;;
      *ecparam*) echo "PEM-STUB" ;;
      *" ec "*) cat >/dev/null; cat "$STUB_DIR/ec-text.txt" ;;
    esac ;;
esac
exit 0
STUB
cat > "$BIN/uname" <<'STUB'
#!/usr/bin/env bash
if [[ -n "${STUB_UNAME_S:-}" ]]; then
  case "${1:-}" in -s) echo "$STUB_UNAME_S" ;; -m) echo "${STUB_UNAME_M:-x86_64}" ;; *) echo "$STUB_UNAME_S stub" ;; esac
else
  exec "$REAL_UNAME" "$@"
fi
STUB
cat > "$BIN/open" <<'STUB'
#!/usr/bin/env bash
echo "open $*" >> "$STUB_DIR/open.log"
rm -f "$STUB_DIR/daemon-down"
STUB
cat > "$BIN/sw_vers" <<'STUB'
#!/usr/bin/env bash
echo "${STUB_MACOS:-14.5}"
STUB
cat > "$BIN/minisign" <<'STUB'
#!/usr/bin/env bash
echo "minisign $*" >> "$STUB_DIR/minisign.log"
[[ -n "${STUB_MINISIGN_FAIL:-}" && "$*" == *"$STUB_MINISIGN_FAIL"* ]] && exit 1
exit 0
STUB
cat > "$BIN/id" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "-u" && -n "${STUB_UID:-}" ]]; then echo "$STUB_UID"; else exec /usr/bin/id "$@"; fi
STUB
# Anything that needs root on Linux: Desktop must never reach it.
for cmd in sudo chown systemctl iptables systemd-tmpfiles sysctl getenforce; do
  printf '#!/usr/bin/env bash\necho "%s $*" >> "$STUB_DIR/rootcmds.log"\nexit 0\n' "$cmd" > "$BIN/$cmd"
done
chmod +x "$BIN"/*
export PATH="$BIN:$ORIG_PATH"

# Canned `openssl ec -noout -text` output for the VAPID container fallback.
openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null | openssl ec -noout -text 2>/dev/null > "$STUB_DIR/ec-text.txt"

# --- in-process overrides (spies + no network) ---------------------------------

SPY="$TMP/spy.log"
spy() { echo "$1" >> "$SPY"; }
require_root() { spy require_root; return 0; }
install_mcp_broker_root() { spy install_mcp_broker_root; }
install_docker_user_rules() { spy install_docker_user_rules; }
check_selinux() { spy check_selinux; }
check_network_environment() { spy check_network_environment; }
check_registry_reachability() { :; }
check_clock_skew() { :; }
wait_for_stack_ready() { return 0; }
write_diagnostics_bundle() { :; }
have_ss() { return 0; }
run_ss() { :; }
docker_port_lookup() { echo ""; }
MIN_DISK_KB=1

# A fake bundle: real hashes in versions.json, so the REAL verify_bundle_integrity
# (with the stub minisign) runs against it.
fetch_bundle() {
  local d="$1" f platforms json_files="{}" imgs
  mkdir -p "$d"
  printf 'services: {}\n' > "$d/compose.yml"
  printf '# overlay\n' > "$d/compose.desktop.yml"
  for f in rustfs-init.sh docker-user-rules.sh LICENSE NOTICE OPEN-SOURCE-NOTICES rocketchat-upstream-files.txt TRADEMARK.md; do
    printf 'fixture %s\n' "$f" > "$d/$f"
  done
  # Executed on Desktop (--check validates the egress settings before compose up).
  cp "$SELF_DIR/../docker-user-rules.sh" "$d/docker-user-rules.sh"
  printf 'sig\n' > "$d/compose.yml.minisig"; printf 'sig\n' > "$d/versions.json.minisig"; printf 'sig\n' > "$d/compose.desktop.yml.minisig"
  for f in "${UNSIGNED_HASHED_FILES[@]}" compose.desktop.yml; do
    json_files="$(jq -c --arg f "$f" --arg h "$(sha256_file "$d/$f")" '. + {($f): {sha256: $h}}' <<<"$json_files")"
  done
  case "${STUB_PLATFORMS:-both}" in
    both)  platforms='"platforms":["linux/amd64","linux/arm64"],' ;;
    amd64) platforms='"platforms":["linux/amd64"],' ;;
    *)     platforms='' ;;
  esac
  imgs="{\"netguard\":{${platforms}\"repository\":\"ghcr.io/privos-ai/privos-netguard\",\"tag\":\"v9.9.9\",\"digest\":\"sha256:abc\"},\"hub\":{${platforms}\"repository\":\"ghcr.io/privos-ai/privos-hub\"},\"mongo\":{${platforms}\"repository\":\"mongo\"}}"
  printf '{\n  "stackVersion": "v9.9.9",\n  "images": %s,\n  "files": %s\n}\n' "$imgs" "$json_files" > "$d/versions.json"
}

reset_stubs() {
  rm -f "$STUB_DIR/docker.log" "$STUB_DIR/open.log" "$STUB_DIR/minisign.log" "$STUB_DIR/rootcmds.log" "$STUB_DIR/daemon-down" "$SPY"
  : > "$STUB_DIR/docker.log"; : > "$SPY"
  unset STUB_ARCH STUB_UID STUB_MINISIGN_FAIL STUB_API STUB_COMPOSE_VER STUB_CONTEXT STUB_MEM STUB_MACOS STUB_UNAME_M
  STUB_PLATFORMS=both; export STUB_PLATFORMS
}

spy_count() { grep -c "^$1\$" "$SPY" 2>/dev/null; true; }

run_main() {  # run_main <main args…> -> OUT, RC (own subshell with set -e, like production)
  OUT="$( exec 2>&1; set -e; main "$@" )"
  RC=$?
}

DESK_DIR="$HOME/.privos"
printf '{"AutoStart": false}\n' > "$HOME/Library/Group Containers/group.com.docker/settings-store.json"

# --- host OS detection --------------------------------------------------------

( unset PRIVOS_HOST_OS; STUB_UNAME_S=Darwin; export STUB_UNAME_S; detect_host_os; echo "$HOST_OS" ) > "$TMP/os1" 2>&1
assert_eq "darwin" "$(cat "$TMP/os1")" "detect_host_os: uname -s Darwin -> darwin"
( unset PRIVOS_HOST_OS; detect_host_os; echo "$HOST_OS" ) > "$TMP/os2" 2>&1
assert_eq "linux" "$(cat "$TMP/os2")" "detect_host_os: this Linux host -> linux"
( unset PRIVOS_HOST_OS; STUB_UNAME_S=FreeBSD; export STUB_UNAME_S; detect_host_os ) > "$TMP/os3" 2>&1
assert_status 1 "$?" "detect_host_os: an unsupported OS is refused"
assert_contains "$(cat "$TMP/os3")" "install.ps1" "detect_host_os: points Windows users at install.ps1"
( PRIVOS_HOST_OS=darwin; export PRIVOS_HOST_OS; detect_host_os; echo "$HOST_OS" ) > "$TMP/os4" 2>&1
assert_eq "darwin" "$(cat "$TMP/os4")" "detect_host_os: PRIVOS_HOST_OS=darwin wins over uname"
( PRIVOS_HOST_OS=beos; export PRIVOS_HOST_OS; detect_host_os ) >/dev/null 2>&1
assert_status 1 "$?" "detect_host_os: a bad PRIVOS_HOST_OS is refused"

# --- directory + compose invocation --------------------------------------------

HOST_OS=darwin
assert_eq "$HOME/.privos" "$(default_privos_dir)" "default dir on macOS is \$HOME/.privos"
assert_eq "$HOME/.privos" "$(validate_privos_dir "$HOME/.privos")" "validate_privos_dir accepts the macOS default"
( validate_privos_dir "$HOME" ) >/dev/null 2>&1; assert_status 1 "$?" "validate_privos_dir still refuses \$HOME itself"
( validate_privos_dir "/Users" ) >/dev/null 2>&1; assert_status 1 "$?" "validate_privos_dir refuses /Users"
( validate_privos_dir "/Applications" ) >/dev/null 2>&1; assert_status 1 "$?" "validate_privos_dir refuses /Applications"
HOST_OS=linux
assert_eq "/opt/privos" "$(default_privos_dir)" "default dir on Linux stays /opt/privos"

reset_stubs
COMPOSE_FILE="$TMP/c/compose.yml"; ENV_FILE="$TMP/c/.env"; PRIVOS_PROJECT=privos
mkdir -p "$TMP/c"; : > "$TMP/c/compose.yml"; : > "$TMP/c/compose.desktop.yml"
HOST_OS=darwin; compose ps >/dev/null
HOST_OS=linux;  compose ps >/dev/null
d_line="$(grep -F -- '--env-file' "$STUB_DIR/docker.log" | sed -n 1p)"
l_line="$(grep -F -- '--env-file' "$STUB_DIR/docker.log" | sed -n 2p)"
assert_contains "$d_line" "-f $TMP/c/compose.yml -f $TMP/c/compose.desktop.yml --env-file $TMP/c/.env --project-name privos ps" "compose(): Desktop passes the overlay as a second -f"
assert_not_contains "$l_line" "compose.desktop.yml" "compose(): Linux never passes the overlay"

# --- root is refused on macOS, required on Linux ---------------------------------

reset_stubs
export PRIVOS_HOST_OS=darwin STUB_UNAME_S=Darwin
STUB_UID=0 run_main --yes --dir "$DESK_DIR"
assert_status 1 "$RC" "darwin: running as root is refused"
assert_contains "$OUT" "do not run this installer as root or with sudo on macOS" "darwin: root refusal explains why"
assert_eq "0" "$(spy_count require_root)" "darwin: require_root (Linux-only) is not called"
assert_not_contains "$(cat "$STUB_DIR/docker.log")" "compose" "darwin: nothing touched docker before the root refusal"

reset_stubs
STUB_UID=0 run_main --uninstall --dir "$DESK_DIR"
assert_status 1 "$RC" "darwin: uninstall as root is refused as well"

# --- fresh install ----------------------------------------------------------------

reset_stubs
rm -rf "$DESK_DIR"
export STUB_UNAME_M=x86_64
run_main --yes
assert_status 0 "$RC" "darwin install (x86_64 engine): exits 0"
[[ "$RC" -eq 0 ]] || printf '%s\n' "$OUT" >&2
assert_contains "$OUT" "Platform: macOS 14.5" "darwin install: platform line names macOS"
assert_contains "$OUT" "Request code:   PRV-TEST-CODE" "darwin install: the activation code is read through compose exec"
assert_eq "true" "$([[ -d "$DESK_DIR" ]] && echo true || echo false)" "darwin install: default dir \$HOME/.privos was used"
assert_eq "true" "$([[ -f "$DESK_DIR/compose.desktop.yml" && -f "$DESK_DIR/.env" ]] && echo true || echo false)" "darwin install: overlay and .env are in the install dir"
assert_eq "false" "$([[ -e "$DESK_DIR/data" ]] && echo true || echo false)" "darwin install: no host data/ directories (named volumes)"
assert_eq "600" "$(stat -c %a "$DESK_DIR/secrets/mongo-keyfile" 2>/dev/null || stat -f %Lp "$DESK_DIR/secrets/mongo-keyfile")" "darwin install: keyfile is user-owned 0600"
assert_eq "700" "$(stat -c %a "$DESK_DIR/secrets" 2>/dev/null || stat -f %Lp "$DESK_DIR/secrets")" "darwin install: secrets dir is 0700"
env_text="$(cat "$DESK_DIR/.env")"
assert_contains "$env_text" "PRIVOS_DOCKER_SOCKET_GID='2375'" "darwin install: docker socket gid is probed from the daemon side (2375), not assumed 0"
assert_contains "$(cat "$STUB_DIR/docker.log")" "run --rm --network none --entrypoint stat -v /var/run/docker.sock:/s ghcr.io/privos-ai/privos-netguard:v9.9.9@sha256:abc -c %g /s" "darwin install: the probe uses the verified netguard image"
assert_eq "" "$(cat "$STUB_DIR/rootcmds.log" 2>/dev/null)" "darwin install: probing the socket needs no host stat/chown"
assert_contains "$env_text" "PRIVOS_DIR='$DESK_DIR'" "darwin install: .env records the macOS dir"
assert_contains "$env_text" "PRIVOS_STACK_VERSION='v9.9.9'" "darwin install: stack version adopted from the verified bundle"
compose_calls="$(grep -c '^compose -f' "$STUB_DIR/docker.log")"
no_overlay="$(grep '^compose -f' "$STUB_DIR/docker.log" | grep -vc 'compose.desktop.yml')"
assert_eq "true" "$([[ "$compose_calls" -gt 3 ]] && echo true || echo false)" "darwin install: compose was driven (${compose_calls} calls)"
assert_eq "0" "$no_overlay" "darwin install: every compose call carries compose.desktop.yml"
assert_contains "$(cat "$STUB_DIR/docker.log")" "up -d mongo redis rustfs" "darwin install: bring-up sequence ran"
assert_contains "$(cat "$STUB_DIR/docker.log")" "network create privos-sandbox-net" "darwin install: data-plane network created"
assert_contains "$(cat "$STUB_DIR/docker.log")" "com.docker.network.bridge.name=privos-agent0" "darwin install: agent network created"
for fn in require_root install_mcp_broker_root install_docker_user_rules check_selinux check_network_environment; do
  assert_eq "0" "$(spy_count "$fn")" "darwin install: Linux-only ${fn} not called"
done
assert_eq "" "$(cat "$STUB_DIR/rootcmds.log" 2>/dev/null)" "darwin install: no sudo/chown/systemctl/iptables/sysctl/tmpfiles invoked"
assert_contains "$(cat "$STUB_DIR/minisign.log")" "compose.desktop.yml" "darwin install: the overlay's minisign signature was verified"
assert_contains "$OUT" "com.docker.backend may accept incoming connections" "darwin install: explains the firewall prompt before compose up"
assert_contains "$OUT" "Docker Desktop is NOT set to start when you sign in" "darwin install: autostart off -> warning"
assert_contains "$OUT" "Start Docker Desktop when you sign in" "darwin install: autostart hint names the exact toggle"

# autostart on / unreadable
printf '{"AutoStart": true}\n' > "$HOME/Library/Group Containers/group.com.docker/settings-store.json"
assert_contains "$(desktop_autostart_hint 2>&1)" "starts when you sign in" "autostart hint: AutoStart true -> reassurance"
rm -f "$HOME/Library/Group Containers/group.com.docker/settings-store.json"
printf '{"autoStart": false}\n' > "$HOME/Library/Group Containers/group.com.docker/settings.json"
assert_contains "$(desktop_autostart_hint 2>&1)" "NOT set to start" "autostart hint: legacy settings.json autoStart false -> warning"
rm -f "$HOME/Library/Group Containers/group.com.docker/settings.json"
assert_contains "$(desktop_autostart_hint 2>&1)" "could not be read" "autostart hint: no settings file -> soft hint, never fatal"

# --- re-run (upgrade) keeps working on the same dir ---------------------------------

reset_stubs
run_main --yes --upgrade
assert_status 0 "$RC" "darwin --upgrade over an existing install: exits 0"
assert_contains "$OUT" "License already accepted" "darwin --upgrade: licence marker reused"

# --- socket gid probe failure falls back to 0 with a warning ----------------------------

reset_stubs
rm -f "$DESK_DIR/.env"
STUB_SOCK_GID=fail run_main --yes
assert_status 0 "$RC" "socket gid probe failing is not fatal"
assert_contains "$OUT" "could not read the docker socket's group" "socket gid probe failure warns"
assert_contains "$(cat "$DESK_DIR/.env")" "PRIVOS_DOCKER_SOCKET_GID='0'" "socket gid probe failure falls back to 0"
reset_stubs
run_main --yes --without-app-cluster --upgrade
assert_not_contains "$(cat "$STUB_DIR/docker.log")" "--entrypoint stat" "no socket probe when the App Cluster is off"

# --- platform gating (arm64 engine) ----------------------------------------------------

reset_stubs
STUB_ARCH=aarch64 STUB_PLATFORMS=amd64 run_main --yes --upgrade
assert_status 1 "$RC" "arm64 engine + versions.json without linux/arm64: refused"
assert_contains "$OUT" "not published for macOS yet" "arm64 refusal names the problem"
assert_not_contains "$(cat "$STUB_DIR/docker.log")" " pull" "arm64 refusal happens before any image pull"
assert_not_contains "$OUT" "Rosetta" "arm64 refusal does not suggest Rosetta"

reset_stubs
STUB_ARCH=arm64 STUB_PLATFORMS=none run_main --yes --upgrade
assert_status 1 "$RC" "arm64 engine + images without a platforms field: counted as amd64-only"

reset_stubs
STUB_ARCH=aarch64 STUB_PLATFORMS=both STUB_UNAME_M=arm64 run_main --yes --upgrade
assert_status 0 "$RC" "arm64 engine + every image lists linux/arm64: accepted"
assert_contains "$OUT" "Docker engine is arm64" "arm64 acceptance is logged"

reset_stubs
STUB_ARCH=x86_64 STUB_PLATFORMS=amd64 run_main --yes --upgrade
assert_status 1 "$RC" "Intel Mac + release without linux/arm64: refused (macOS ships only with arm64 releases)"
assert_contains "$OUT" "not published for macOS yet" "Intel Mac refusal names the problem"

reset_stubs
( HOST_OS=linux; STUB_ARCH=x86_64; export STUB_ARCH; check_image_platforms "$DESK_DIR" ) >/dev/null 2>&1
assert_status 0 "$?" "Linux amd64 engine ignores the platforms list"

reset_stubs
STUB_PLATFORMS=both run_main --yes --upgrade
assert_status 0 "$RC" "Intel Mac + release with linux/arm64 everywhere: accepted"

reset_stubs
PRIVOS_EGRESS_ALLOWLIST="10.0.0.0/33" run_main --yes --upgrade
assert_status 1 "$RC" "Desktop: a malformed PRIVOS_EGRESS_ALLOWLIST aborts before compose up"
assert_not_contains "$(cat "$STUB_DIR/docker.log")" "up -d" "Desktop: nothing started after an egress validation failure"
# The rejected value was persisted to .env (as on Linux); drop it for the next cases.
sed -i.bak '/^PRIVOS_EGRESS_ALLOWLIST=/d' "$DESK_DIR/.env" && rm -f "$DESK_DIR/.env.bak"

# --- bundle integrity of the overlay ------------------------------------------------------

reset_stubs
STUB_MINISIGN_FAIL=compose.desktop.yml run_main --yes --upgrade
assert_status 1 "$RC" "overlay with a bad signature: install aborts"
assert_contains "$OUT" "signature verification FAILED" "overlay signature failure is reported"
assert_not_contains "$(cat "$STUB_DIR/docker.log")" " pull" "overlay signature failure happens before any compose pull"

mkdir -p "$TMP/vb"
fetch_bundle "$TMP/vb"
printf '# tampered\n' > "$TMP/vb/compose.desktop.yml"
( HOST_OS=darwin; verify_bundle_integrity "$TMP/vb" ) >"$TMP/vb.out" 2>&1
assert_status 1 "$?" "overlay swapped after signing: sha256 check catches it on Desktop"
assert_contains "$(cat "$TMP/vb.out")" "sha256 mismatch for compose.desktop.yml" "overlay hash mismatch is named"
( HOST_OS=linux; verify_bundle_integrity "$TMP/vb" ) >/dev/null 2>&1
assert_status 0 "$?" "Linux verification does not look at the overlay"

# --- Docker Desktop availability ----------------------------------------------------------------

reset_stubs
touch "$STUB_DIR/daemon-down"
run_main --yes --upgrade
assert_status 0 "$RC" "Desktop installed but stopped: started and the install continues"
assert_contains "$(cat "$STUB_DIR/open.log")" "open -a $PRIVOS_DOCKER_DESKTOP_APP" "Desktop stopped: open -a launches the app"
assert_contains "$OUT" "starting it" "Desktop stopped: the user is told"

reset_stubs
touch "$STUB_DIR/daemon-down"
( PRIVOS_DOCKER_DESKTOP_APP="$TMP/NoSuch.app"; HOME="$TMP/nohome"; ensure_docker_desktop ) >"$TMP/nodesk.out" 2>&1
assert_status 1 "$?" "Desktop not installed: stops"
assert_contains "$(cat "$TMP/nodesk.out")" "https://www.docker.com/products/docker-desktop/" "Desktop not installed: prints the download URL"
assert_eq "false" "$([[ -f "$STUB_DIR/open.log" ]] && echo true || echo false)" "Desktop not installed: open is not attempted"

reset_stubs
touch "$STUB_DIR/daemon-down"
printf '#!/usr/bin/env bash\necho "open $*" >> "$STUB_DIR/open.log"\n' > "$BIN/open"; chmod +x "$BIN/open"
( DESKTOP_START_TIMEOUT_SEC=2; ensure_docker_desktop ) >"$TMP/slow.out" 2>&1
assert_status 1 "$?" "Desktop that never answers: gives up after the timeout"
assert_contains "$(cat "$TMP/slow.out")" "did not become ready within 2s" "Desktop timeout message"
printf '#!/usr/bin/env bash\necho "open $*" >> "$STUB_DIR/open.log"\nrm -f "$STUB_DIR/daemon-down"\n' > "$BIN/open"; chmod +x "$BIN/open"

reset_stubs
( export STUB_COMPOSE_VER=v2.26.1; ensure_docker_desktop ) >"$TMP/cv.out" 2>&1; rc=$?
assert_status 1 "$rc" "compose < 2.27.0 on Desktop is refused (overlay needs subpath/!override)"
assert_contains "$(cat "$TMP/cv.out")" "Docker Compose >= 2.27.0" "compose version refusal names the minimum"
( export STUB_API=1.44; ensure_docker_desktop ) >"$TMP/api.out" 2>&1; rc=$?
assert_status 1 "$rc" "engine API < 1.45 on Desktop is refused"
assert_contains "$(cat "$TMP/api.out")" "Docker Engine API >= 1.45" "API refusal names the minimum"
( export STUB_CONTEXT=colima; ensure_docker_desktop ) >"$TMP/ctx.out" 2>&1; rc=$?
assert_status 0 "$rc" "a non-Desktop docker context is only a warning"
assert_contains "$(cat "$TMP/ctx.out")" "not Docker Desktop's 'desktop-linux'" "foreign docker context is called out"

reset_stubs
HOST_OS=darwin
assert_eq "7000" "$(export STUB_MEM=7340032000; desktop_vm_memory_mb)" "desktop_vm_memory_mb: reads the VM's MemTotal in MB"
( export STUB_MEM=2147483648; PRIVOS_DIR="$DESK_DIR"; check_resources ) >"$TMP/mem.out" 2>&1
assert_status 1 "$?" "a 2 GB Desktop VM is refused"
assert_contains "$(cat "$TMP/mem.out")" "Settings → Resources → Memory" "low-memory refusal names the Desktop setting"
( export STUB_MEM=8589934592; PRIVOS_DIR="$DESK_DIR"; check_resources ) >"$TMP/mem2.out" 2>&1
assert_status 0 "$?" "an 8 GB Desktop VM passes"
assert_contains "$(cat "$TMP/mem2.out")" "Virtual disk limit" "resource check mentions the Desktop disk limit"

HOST_OS=linux
reset_stubs
STUB_MACOS=12.7 run_main --yes --upgrade
assert_status 1 "$RC" "macOS 12 is refused"
assert_contains "$OUT" "macOS 13 or newer is required" "macOS version refusal names the minimum"

# --- tools: pinned download must match its baked sha256 ----------------------------------------

reset_stubs
mkdir -p "$TMP/tools-home/.privos" "$TMP/curlbin"
cat > "$TMP/curlbin/curl" <<'STUB'
#!/usr/bin/env bash
out=""; while [[ $# -gt 0 ]]; do [[ "$1" == "-o" ]] && out="$2"; shift; done
echo "tampered download" > "$out"
STUB
chmod +x "$TMP/curlbin/curl"
( PATH="$TMP/curlbin:$PATH"; PRIVOS_DIR="$TMP/tools-home/.privos"; download_pinned_tool jq ) >"$TMP/dl.out" 2>&1
assert_status 1 "$?" "pinned jq: a download with the wrong sha256 is refused"
assert_contains "$(cat "$TMP/dl.out")" "sha256 mismatch" "pinned jq: mismatch is reported"
assert_eq "false" "$([[ -e "$TMP/tools-home/.privos/bin/jq" ]] && echo true || echo false)" "pinned jq: nothing is installed after a mismatch"
( PATH="$TMP/curlbin:$PATH"; PRIVOS_DIR="$TMP/tools-home/.privos"; download_pinned_tool minisign ) >"$TMP/dl2.out" 2>&1
assert_status 1 "$?" "pinned minisign: a download with the wrong sha256 is refused"
assert_eq "64" "${#JQ_MACOS_ARM64_SHA256}" "pinned jq arm64 sha256 is baked"
assert_eq "64" "${#JQ_MACOS_AMD64_SHA256}" "pinned jq amd64 sha256 is baked"
assert_eq "64" "${#MINISIGN_MACOS_ZIP_SHA256}" "pinned minisign sha256 is baked"
assert_contains "$OPENSSL_FALLBACK_IMAGE" "@sha256:" "openssl fallback image is digest-pinned"

# require_host_tools on Darwin only needs curl and openssl up front
( HOST_OS=darwin; PRIVOS_DIR="$TMP/tools-home/.privos"; require_host_tools ) >/dev/null 2>&1
assert_status 0 "$?" "darwin require_host_tools: curl + openssl present is enough before the licence step"

# --- VAPID fallback in a pinned container when the host openssl is unusable ---------------------

reset_stubs
(
  HOST_OS=darwin
  openssl() { case "$1" in ecparam|ec) return 1 ;; *) command openssl "$@" ;; esac; }
  generate_vapid_keypair
  echo "${#VAPID_PRIVATE_KEY} ${#VAPID_PUBLIC_KEY}"
) >"$TMP/vapid.out" 2>&1
assert_contains "$(cat "$TMP/vapid.out")" "43 87" "darwin: unusable host openssl -> keypair generated by the pinned container"
assert_contains "$(cat "$STUB_DIR/docker.log")" "alpine/openssl@sha256:" "darwin: the fallback container is the digest-pinned image"
( HOST_OS=linux; openssl() { case "$1" in ecparam|ec) return 1 ;; *) command openssl "$@" ;; esac; }; generate_vapid_keypair ) >"$TMP/vapid2.out" 2>&1
assert_status 1 "$?" "linux: unusable host openssl is a hard error (no container fallback)"

# --- uninstall --------------------------------------------------------------------------------------

reset_stubs
run_main --uninstall --dir "$DESK_DIR"
assert_status 0 "$RC" "darwin --uninstall: exits 0"
assert_contains "$(cat "$STUB_DIR/docker.log")" "down --remove-orphans" "darwin --uninstall: compose down"
assert_not_contains "$(cat "$STUB_DIR/docker.log")" "volume rm" "darwin --uninstall without --purge keeps the volumes"
assert_eq "true" "$([[ -d "$DESK_DIR" ]] && echo true || echo false)" "darwin --uninstall without --purge keeps the install dir"

reset_stubs
touch "$STUB_DIR/daemon-down"
printf '#!/usr/bin/env bash\necho "open $*" >> "$STUB_DIR/open.log"\n' > "$BIN/open"; chmod +x "$BIN/open"
run_main --uninstall --purge --dir "$DESK_DIR"
assert_status 1 "$RC" "darwin --uninstall --purge with Desktop stopped: refuses instead of deleting the dir"
assert_eq "true" "$([[ -d "$DESK_DIR" ]] && echo true || echo false)" "darwin purge refusal leaves the install dir alone"
printf '#!/usr/bin/env bash\necho "open $*" >> "$STUB_DIR/open.log"\nrm -f "$STUB_DIR/daemon-down"\n' > "$BIN/open"; chmod +x "$BIN/open"

reset_stubs
run_main --uninstall --purge --dir "$DESK_DIR"
assert_status 0 "$RC" "darwin --uninstall --purge: exits 0"
dlog="$(cat "$STUB_DIR/docker.log")"
assert_contains "$dlog" "down --volumes --remove-orphans" "purge: compose down --volumes --remove-orphans"
assert_contains "$dlog" "volume ls -q --filter label=com.docker.compose.project=privos" "purge: leftover project volumes are listed by compose label"
assert_contains "$dlog" "volume rm privos-mongo" "purge: leftover volume privos-mongo removed"
assert_contains "$dlog" "volume rm privos-sandbox-pool" "purge: leftover volume privos-sandbox-pool removed"
assert_contains "$dlog" "rm -f agent-vm-1" "purge: agent VM containers on the agent network removed"
assert_contains "$dlog" "network rm privos-sandbox-net" "purge: data-plane network removed"
assert_contains "$dlog" "network rm privos-agent-net" "purge: agent network removed"
assert_eq "false" "$([[ -e "$DESK_DIR" ]] && echo true || echo false)" "purge: install dir removed"
assert_eq "" "$(cat "$STUB_DIR/rootcmds.log" 2>/dev/null)" "purge: no sudo/systemctl/iptables/rm of /usr/local/sbin"

report_and_exit
