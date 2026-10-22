#!/usr/bin/env bash
# The self-hosted parser files: compose.parser.yml (+ same-host overlay),
# env.parser.template and docs/parser/README.md. Checks that the publisher
# pins and ships them like the other images, that the stack renders once the
# digest placeholders are resolved, that the template documents every variable
# the compose file reads, and that the guide states where operator data goes.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SELF_DIR/helpers.sh"
cd "$SELF_DIR/.." || exit 1

COMPOSE=compose.parser.yml
OVERLAY=compose.parser.same-host.yml
TEMPLATE=env.parser.template
GUIDE=docs/parser/README.md

# --- publisher: pinned, hashed, uploaded -------------------------------------
# shellcheck source=/dev/null
( source ./publish-self-hosted-bundle.sh
  in_array() { local x="$1"; shift; local e; for e in "$@"; do [[ "$e" == "$x" ]] && return 0; done; return 1; }
  rc=0
  in_array "$COMPOSE" "${DIGEST_FILES[@]}" || rc=1
  for f in "$COMPOSE" "$OVERLAY" "$TEMPLATE"; do in_array "$f" "${HASHED_FILES[@]}" || rc=1; done
  printf '%s\n' "${IMAGE_REFS[@]}" | grep -qx 'parser|ghcr.io/privos-ai/privos-parser:[^|]*|__PARSER_DIGEST__' || rc=1
  exit "$rc" ) >/dev/null 2>&1
assert_status 0 "$?" "publisher: parser image is in IMAGE_REFS, the compose file gets digests, all three files are hashed"

pub="$(cat publish-self-hosted-bundle.sh)"
for f in "$COMPOSE" "$OVERLAY" "$TEMPLATE"; do
  assert_contains "$pub" "\"\$work/$f\"" "publisher uploads $f"
done
assert_contains "$pub" "for f in $COMPOSE $OVERLAY $TEMPLATE" "publisher copies the three files into the publish dir"

if command -v jq >/dev/null 2>&1; then
  tag_in_script="$(grep -o 'ghcr.io/privos-ai/privos-parser:[^|]*' publish-self-hosted-bundle.sh | head -1 | sed 's/.*://')"
  tag_in_versions="$(jq -r '.images.parser.tag' versions.json)"
  tag_in_compose="$(sed -n 's|.*image: ghcr.io/privos-ai/privos-parser:\([^@]*\)@sha256:__PARSER_DIGEST__$|\1|p' "$COMPOSE")"
  assert_eq "$tag_in_versions" "$tag_in_script" "parser tag: publisher script matches versions.json"
  assert_eq "$tag_in_versions" "$tag_in_compose" "parser tag: $COMPOSE matches versions.json"
  assert_eq "ghcr.io/privos-ai/privos-parser|__PARSER_DIGEST__" \
    "$(jq -r '.images.parser | "\(.repository)|\(.digest)"' versions.json)" "versions.json: parser repository and digest placeholder"
  for f in "$COMPOSE" "$OVERLAY" "$TEMPLATE"; do
    assert_eq "null" "$(jq -c ".files[\"$f\"].sha256" versions.json)" "versions.json lists $f with a hash slot"
  done
fi

compose_text="$(cat "$COMPOSE")"
for p in __PARSER_DIGEST__ __REDIS_DIGEST__ __MONGO_DIGEST__; do
  assert_contains "$compose_text" "@sha256:$p" "$COMPOSE pins an image with $p"
done
assert_not_contains "$compose_text" "PARSER_VERSION" "$COMPOSE has no operator-chosen image tag"

# --- the env template documents every variable the compose files read --------
referenced="$(grep -oE '\$\{[A-Z][A-Z0-9_]*[:}?-]' "$COMPOSE" "$OVERLAY" | sed -E 's/.*\$\{([A-Z0-9_]+).*/\1/' | sort -u)"
documented="$(grep -oE '^[A-Z][A-Z0-9_]*=' "$TEMPLATE" | tr -d '=' | sort -u)"
missing="$(comm -23 <(printf '%s\n' "$referenced") <(printf '%s\n' "$documented") | grep -vxE 'COMPOSE_PROJECT_NAME|PARSER_CONTAINER_NAME' | tr '\n' ' ')"
assert_eq "" "$missing" "$TEMPLATE lists every variable the compose files read"

# No secret ships with a value.
for k in PARSER_API_KEY MONGO_PASSWORD RUSTFS_ACCESS_KEY RUSTFS_SECRET_KEY VISION_API_KEY VISION_API_BASE_URL VISION_API_MODEL; do
  assert_eq "" "$(sed -n "s/^$k=//p" "$TEMPLATE")" "$TEMPLATE: $k is empty"
done
assert_eq "compose.parser.yml:compose.parser.same-host.yml" "$(sed -n 's/^COMPOSE_FILE=//p' "$TEMPLATE")" \
  "$TEMPLATE: COMPOSE_FILE selects the bundle's file names"

# --- rendering, as the publisher resolves the digests -------------------------
if docker compose version >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  d="$(printf 'a%.0s' $(seq 64))"
  sed -e "s|__PARSER_DIGEST__|$d|g" -e "s|__REDIS_DIGEST__|$d|g" -e "s|__MONGO_DIGEST__|$d|g" "$COMPOSE" > "$work/$COMPOSE"
  cp "$OVERLAY" "$work/$OVERLAY"
  cat > "$work/env" <<'EOF'
PARSER_API_KEY=0000000000000000000000000000000000000000000000000000000000000000
VISION_API_BASE_URL=http://vision.invalid
VISION_API_MODEL=model
RUSTFS_ENDPOINT=privos-rustfs:9000
RUSTFS_ACCESS_KEY=access
RUSTFS_SECRET_KEY=secret
MONGO_PASSWORD=password
EOF

  cfg="$(docker compose -f "$work/$COMPOSE" --env-file "$work/env" config --format json 2>&1)"
  assert_status 0 "$?" "$COMPOSE renders with a complete .env"
  q() { jq -r "$1" <<< "$cfg"; }
  assert_eq "ghcr.io/privos-ai/privos-parser:$(jq -r '.images.parser.tag' versions.json)@sha256:$d" "$(q '.services.parser.image')" \
    "parser image is tag plus resolved digest"
  assert_eq "127.0.0.1:8000" "$(q '.services.parser.ports[] | "\(.host_ip):\(.published)"')" "the parser is published on loopback by default"
  assert_eq "true" "$(q '.services.parser.environment.PARSER_STANDALONE')" "the parser runs the standalone profile"
  assert_eq "redis-server --appendonly yes --appendfsync always --no-appendfsync-on-rewrite no --aof-load-truncated no --maxmemory-policy noeviction" \
    "$(q '.services.redis.command | join(" ")')" "redis keeps the durability policy the parser requires"
  assert_eq "" "$(q '[.services.redis.ports, .services.mongo.ports] | map(select(. != null)) | length | select(. > 0)')" "redis and mongo are not published"

  overlay_cfg="$(docker compose -f "$work/$COMPOSE" -f "$work/$OVERLAY" --env-file "$work/env" config --format json 2>&1)"
  assert_status 0 "$?" "$COMPOSE + $OVERLAY render"
  assert_eq "default,privos" "$(jq -r '.services.parser.networks | keys | join(",")' <<< "$overlay_cfg")" "the overlay joins the Hub network"
  assert_eq "true" "$(jq -r '.networks.privos.external' <<< "$overlay_cfg")" "the Hub network is external"

  # Compose must refuse to start without the access key, not default it.
  grep -v '^PARSER_API_KEY=' "$work/env" > "$work/env-no-key"
  err="$(docker compose -f "$work/$COMPOSE" --env-file "$work/env-no-key" config 2>&1)"
  assert_contains "$err" "PARSER_API_KEY" "compose refuses to render without PARSER_API_KEY"
else
  echo "SKIP - docker compose or jq not available; $COMPOSE rendering not checked"
fi

# --- guide ----------------------------------------------------------------------
guide="$(cat "$GUIDE")"
assert_not_contains "$guide" "never leave the host" "guide: no promise that anything stays on the host"
assert_contains "$guide" "Every PDF page is rendered to an image and sent to the vision API" "guide: every PDF page goes to the vision API"
assert_contains "$guide" "text PDFs included" "guide: text PDFs are named"
assert_contains "$guide" "one call for each page" "guide: states the per-page cost"
assert_not_contains "$guide" "unrar" "guide: no unrar"
assert_contains "$guide" "| RAR | no:" "guide: RAR is listed as unsupported"
assert_not_contains "$guide" "PARSER_VERSION" "guide: no operator-chosen image tag"
assert_not_contains "$guide" ".env.example" "guide: names env.parser.template"
assert_contains "$guide" "compose.parser.yml" "guide: names the compose file"
assert_contains "$guide" "/usr/share/doc/privos-parser/THIRD-PARTY-NOTICES" "guide: names the third-party notices file"
for f in "$COMPOSE" "$OVERLAY" "$TEMPLATE" "$GUIDE"; do
  if grep -n -i -E '10\.88\.|wireguard|[a-z0-9.-]+\.privos\.io|/etc/privos|\bmesh\b' "$f" >/dev/null; then
    assert_eq "no internal hostnames" "found one in $f" "$f is free of internal hostnames and addresses"
  else
    assert_eq "ok" "ok" "$f is free of internal hostnames and addresses"
  fi
done
assert_contains "$(cat README.md)" "docs/parser/README.md" "README links the parser guide"

report_and_exit
