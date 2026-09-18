#!/usr/bin/env bash
# Read-only preflight for the self-hosted + new-pricing release (plan 260827-0021).
# Checks G3 (ghcr public) and does a non-blocking sanity fetch of the GitHub
# Releases install URL. G2 (apex/Cloudflare) is DROPPED — the installer is
# served exclusively from GitHub Releases (operator release runbook
# step 7); there is no apex gate left to check.
# Does NOT touch the fleet, DB, docker credentials, or Cloudflare. Exit 0 only if all green.
set -uo pipefail

TAG="${1:-latest}"                       # image tag to test for G3 (default: latest)
INSTALL_URL="${PRIVOS_INSTALL_URL:-https://github.com/PrivOS-AI/privos/releases/latest/download/install.sh}"
PKGS=(privos-hub privos-sandbox-board privos-sandbox-proxy privos-sandbox-vm privos-app-cluster privos-publisher)
ORG="privos-ai"
fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }
info() { printf '  ---- %s\n' "$1"; }

echo "== G2 — DROPPED; sanity-check the GitHub Releases install URL (non-blocking) =="
code="$(curl -fsS -o /dev/null -w '%{http_code}' -L "$INSTALL_URL" 2>/dev/null || true)"
case "$code" in
  200) ok "$INSTALL_URL -> 200" ;;
  404) info "$INSTALL_URL -> 404 (no Release published yet — expected before runbook step 7)" ;;
  *)   info "$INSTALL_URL -> '${code:-no-response}' (not a gate — informational only)" ;;
esac

echo "== G3 — ghcr packages are public (anonymous manifest read) =="
for p in "${PKGS[@]}"; do
  # anonymous pull token, then a HEAD on the manifest — no docker login, no local cred change
  tok="$(curl -fsS "https://ghcr.io/token?scope=repository:${ORG}/${p}:pull" 2>/dev/null | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  mcode="$(curl -fsS -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer ${tok:-anon}" \
      -H 'Accept: application/vnd.oci.image.index.v1+json' \
      -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
      "https://ghcr.io/v2/${ORG}/${p}/manifests/${TAG}" 2>/dev/null || true)"
  case "$mcode" in
    200) ok "ghcr.io/${ORG}/${p}:${TAG} readable anonymously (public)" ;;
    401|403) bad "ghcr.io/${ORG}/${p} -> $mcode (still PRIVATE — set visibility Public in the GitHub UI)" ;;
    404) bad "ghcr.io/${ORG}/${p}:${TAG} -> 404 (GHCR hides PRIVATE packages from anonymous pulls — still private, or wrong tag; real tags look like v7.15.42-tenant.150)" ;;
    *)   bad "ghcr.io/${ORG}/${p} -> '${mcode:-no-response}'" ;;
  esac
done

echo "== Manual gates (not auto-checkable here) =="
info "G5: delta report captured + customer notice SENT (plans/reports/execution-260827-1250-g5-*)"
info "Backup: portal database dump taken this window (runbook step 0)"
info "Bundle: production minisign key + real @sha256 digests (publish --check enforces)"

echo
if [ "$fail" -eq 0 ]; then
  echo "PREFLIGHT: all auto-checked gates GREEN"; exit 0
else
  echo "PREFLIGHT: one or more gates RED — do not start the release"; exit 1
fi
