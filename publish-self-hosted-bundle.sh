#!/usr/bin/env bash
# Resolves pinned image digests, signs versions.json + compose.yml with
# minisign, and publishes the self-hosted bundle to a GitHub repository
# (distributable files pushed to a branch + a signed GitHub Release with the
# same files as assets).
#
# NOT RUN as part of authoring this bundle — this task explicitly excludes
# live image pulls/builds and any push to GitHub. A human operator runs this
# with a real, offline-held minisign secret key (see SIGNING.md) at actual
# release time.
#
#   publish-self-hosted-bundle.sh --stack-version <tag> --minisign-key <path> [--yes]
#   publish-self-hosted-bundle.sh --check   # verify an already-published bundle dir, no key needed
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REPO="PrivOS-AI/privos"
BRANCH="main"
BUNDLE_PATH="self-hosted"
BUNDLE_DIR="$SCRIPT_DIR"
STACK_VERSION=""
MINISIGN_KEY=""
BUNDLE_VERSION=""
DRY_RUN="true"
CHECK_ONLY="false"

MINISIGN_PUBLIC_KEY="RWTSux76l3dmrV5gYhP/M/4jvg6ziwi4q7FmN2bDlMy7USQxpm2XpwWc"

IMAGE_REFS=(
  "hub|ghcr.io/privos-ai/privos-hub|__HUB_DIGEST__"
  "sandboxBoard|ghcr.io/privos-ai/privos-sandbox-board|__SANDBOX_BOARD_DIGEST__"
  "sandboxProxy|ghcr.io/privos-ai/privos-sandbox-proxy|__SANDBOX_PROXY_DIGEST__"
  "sandboxVm|ghcr.io/privos-ai/privos-sandbox-vm|__SANDBOX_VM_DIGEST__"
  "mongo|mongo:7.0.14|__MONGO_DIGEST__"
  "redis|redis:7-alpine|__REDIS_DIGEST__"
  "minio|minio/minio:RELEASE.2025-04-08T15-41-24Z|__MINIO_DIGEST__"
  "minioMc|minio/mc:RELEASE.2025-04-08T15-39-49Z|__MINIO_MC_DIGEST__"
  "weaviate|cr.weaviate.io/semitechnologies/weaviate:1.38.2|__WEAVIATE_DIGEST__"
  "localRuntimeDriver|ghcr.io/privos-ai/privos-local-runtime-driver:v1|__LOCAL_RUNTIME_DRIVER_DIGEST__"
)

SIGNED_FILES=(compose.yml versions.json)
HASHED_FILES=(compose.yml install.sh minio-init.sh docker-user-rules.sh)

log()  { printf '[publish-bundle] %s\n' "$*" >&2; }
die()  { printf '[publish-bundle] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
publish-self-hosted-bundle.sh — resolve digests, sign, publish the bundle.

  --repo <owner/name>       Target GitHub repo (default: PrivOS-AI/privos)
  --branch <name>           Branch to push distributable files to (default: main)
  --stack-version <tag>     Tag family for hub/sandbox-* images (required unless --check)
  --bundle-version <ver>    versions.json bundleVersion (default: <stack-version>)
  --minisign-key <path>     Secret key for signing (required unless --check)
  --bundle-dir <path>       Directory containing the bundle source (default: this script's dir)
  --yes                     Actually push/release (default: dry-run, prints the plan only)
  --check                   Verify an already-published bundle dir: signatures valid, no
                             placeholder digests remain, files{}.sha256 matches disk. No key
                             needed; exits non-zero on the first failure.
  -h, --help                Show this help
USAGE
}

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo) REPO="${2:?}"; shift 2 ;;
      --branch) BRANCH="${2:?}"; shift 2 ;;
      --stack-version) STACK_VERSION="${2:?}"; shift 2 ;;
      --bundle-version) BUNDLE_VERSION="${2:?}"; shift 2 ;;
      --minisign-key) MINISIGN_KEY="${2:?}"; shift 2 ;;
      --bundle-dir) BUNDLE_DIR="${2:?}"; shift 2 ;;
      --yes) DRY_RUN="false"; shift ;;
      --check) CHECK_ONLY="true"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown flag: $1 (see --help)" ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# --check mode: verify an already-published bundle directory
# ---------------------------------------------------------------------------

run_check() {
  local f name ref placeholder digest_field
  cd "$BUNDLE_DIR"

  for f in "${SIGNED_FILES[@]}"; do
    [[ -f "$f" ]] || die "missing ${f}"
    [[ -f "${f}.minisig" ]] || die "missing ${f}.minisig"
    minisign -Vq -m "$f" -x "${f}.minisig" -P "$MINISIGN_PUBLIC_KEY" \
      || die "signature verification failed for ${f}"
    log "OK: ${f} signature verified"
  done

  for entry in "${IMAGE_REFS[@]}"; do
    IFS='|' read -r name ref placeholder <<<"$entry"
    grep -q "$placeholder" compose.yml && die "compose.yml still has an unresolved placeholder for ${name} (${placeholder})"
  done
  log "OK: no unresolved digest placeholders in compose.yml"

  require_cmd jq
  for entry in "${IMAGE_REFS[@]}"; do
    IFS='|' read -r name ref placeholder <<<"$entry"
    digest_field="$(jq -r ".images.${name}.digest // empty" versions.json)"
    [[ -n "$digest_field" ]] || die "versions.json is missing images.${name}.digest"
    [[ "$digest_field" == sha256:* ]] || die "versions.json images.${name}.digest is not a sha256 digest: ${digest_field}"
  done
  log "OK: versions.json carries a resolved sha256 digest for every image"

  for f in "${HASHED_FILES[@]}"; do
    [[ -f "$f" ]] || continue
    local recorded actual
    recorded="$(jq -r ".files[\"${f}\"].sha256 // empty" versions.json)"
    [[ -n "$recorded" ]] || die "versions.json is missing files[\"${f}\"].sha256"
    actual="$(sha256sum "$f" | awk '{print $1}')"
    [[ "$recorded" == "$actual" ]] || die "versions.json files[\"${f}\"].sha256 does not match ${f} on disk (recorded=${recorded} actual=${actual})"
  done
  log "OK: versions.json file hashes match disk"

  log "--check passed."
}

# ---------------------------------------------------------------------------
# Digest resolution (network access to the registries — not run by this task)
# ---------------------------------------------------------------------------

resolve_digest() {
  local ref="$1" digest
  require_cmd docker
  digest="$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"')"
  if [[ -z "$digest" ]] && command -v crane >/dev/null 2>&1; then
    digest="$(crane digest "$ref" 2>/dev/null)"
  fi
  [[ -n "$digest" && "$digest" == sha256:* ]] || die "could not resolve a sha256 digest for ${ref} (need 'docker buildx' or 'crane', and registry access)"
  printf '%s' "$digest"
}

resolve_all_digests() {
  [[ -n "$STACK_VERSION" ]] || die "--stack-version is required"
  local entry name ref_template placeholder ref digest
  declare -gA RESOLVED_DIGEST=()
  for entry in "${IMAGE_REFS[@]}"; do
    IFS='|' read -r name ref_template placeholder <<<"$entry"
    # Entries with no tag baked into ref_template (hub/sandbox-*) are versioned
    # by --stack-version; entries that already carry a tag (mongo, redis,
    # minio, weaviate, local-runtime-driver) are pinned independently.
    ref="$ref_template"
    [[ "$ref" == *:* ]] || ref="${ref_template}:${STACK_VERSION}"
    log "Resolving digest for ${name} (${ref})…"
    digest="$(resolve_digest "$ref")"
    RESOLVED_DIGEST["$name"]="$digest"
    log "  -> ${digest}"
  done
}

# ---------------------------------------------------------------------------
# Rewrite compose.yml / versions.json with resolved digests, then sign
# ---------------------------------------------------------------------------

apply_digests_and_sign() {
  require_cmd jq
  local work="$1" entry name ref_template placeholder digest json f sha

  cp "$BUNDLE_DIR/compose.yml" "$work/compose.yml"
  cp "$BUNDLE_DIR/versions.json" "$work/versions.json"
  for f in install.sh minio-init.sh docker-user-rules.sh env.template; do
    cp "$BUNDLE_DIR/$f" "$work/$f"
  done

  for entry in "${IMAGE_REFS[@]}"; do
    IFS='|' read -r name _ placeholder <<<"$entry"
    digest="${RESOLVED_DIGEST[$name]}"
    sed -i.bak "s|${placeholder}|${digest#sha256:}|g" "$work/compose.yml"
    rm -f "$work/compose.yml.bak"
  done

  json="$(cat "$work/versions.json")"
  json="$(jq --arg sv "$STACK_VERSION" --arg bv "${BUNDLE_VERSION:-$STACK_VERSION}" \
    --arg publishedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.stackVersion = $sv | .bundleVersion = $bv | .publishedAt = $publishedAt' <<<"$json")"
  for entry in "${IMAGE_REFS[@]}"; do
    IFS='|' read -r name _ _ <<<"$entry"
    digest="${RESOLVED_DIGEST[$name]}"
    json="$(jq --arg name "$name" --arg digest "$digest" --arg tag "$STACK_VERSION" \
      '.images[$name].digest = $digest | .images[$name].tag = (if .images[$name].tag == "PLACEHOLDER_STACK_VERSION" then $tag else .images[$name].tag end)' \
      <<<"$json")"
  done
  for f in "${HASHED_FILES[@]}"; do
    [[ -f "$work/$f" ]] || continue
    sha="$(sha256sum "$work/$f" | awk '{print $1}')"
    json="$(jq --arg f "$f" --arg sha "$sha" '.files[$f].sha256 = $sha' <<<"$json")"
  done
  printf '%s\n' "$json" | jq . > "$work/versions.json"

  [[ -n "$MINISIGN_KEY" ]] || die "--minisign-key is required to sign (see SIGNING.md)"
  local f2
  for f2 in "${SIGNED_FILES[@]}"; do
    minisign -S -s "$MINISIGN_KEY" -m "$work/$f2" -t "PrivOS self-hosted bundle ${STACK_VERSION}" \
      || die "signing failed for ${f2}"
    log "Signed ${f2}"
  done
}

# ---------------------------------------------------------------------------
# Publish: push files to the repo branch + create a GitHub Release
# ---------------------------------------------------------------------------

publish() {
  local work="$1"
  require_cmd gh
  require_cmd git

  if [[ "$DRY_RUN" == "true" ]]; then
    log "DRY RUN — would push $(ls "$work") to ${REPO}@${BRANCH}:${BUNDLE_PATH}/ and create release ${STACK_VERSION}. Pass --yes to actually publish."
    return 0
  fi

  local clone_dir
  clone_dir="$(mktemp -d)"
  gh repo clone "$REPO" "$clone_dir" -- --depth=1 --branch "$BRANCH"
  mkdir -p "$clone_dir/$BUNDLE_PATH"
  cp "$work"/{compose.yml,compose.yml.minisig,versions.json,versions.json.minisig,install.sh,minio-init.sh,docker-user-rules.sh,env.template} "$clone_dir/$BUNDLE_PATH/"
  (
    cd "$clone_dir"
    git add "$BUNDLE_PATH"
    git -c user.name="privos-release-bot" -c user.email="release@privos.io" \
      commit -m "self-hosted bundle ${STACK_VERSION}"
    git push origin "HEAD:${BRANCH}"
  )

  gh release create "self-hosted-${STACK_VERSION}" \
    --repo "$REPO" \
    --title "PrivOS self-hosted ${STACK_VERSION}" \
    --notes "Self-hosted installer bundle for stack version ${STACK_VERSION}." \
    "$work/compose.yml" "$work/compose.yml.minisig" \
    "$work/versions.json" "$work/versions.json.minisig" \
    "$work/install.sh" "$work/minio-init.sh" "$work/docker-user-rules.sh"

  rm -rf "$clone_dir"
  log "Published ${STACK_VERSION} to ${REPO}."
}

main() {
  parse_args "$@"

  if [[ "$CHECK_ONLY" == "true" ]]; then
    run_check
    exit 0
  fi

  resolve_all_digests
  local work
  work="$(mktemp -d)"
  apply_digests_and_sign "$work"
  publish "$work"
  rm -rf "$work"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
