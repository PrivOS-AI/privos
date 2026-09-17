#!/bin/sh
# shellcheck shell=sh
#
# Runs inside the rustfs/rc container (docker compose run --rm rustfs-init /
# the one-shot `rustfs-init` service in compose.yml). Reproduces
# privos-portal's rustfs-provisioner.ts for a single-node, single-tenant
# RustFS: create the bucket, enable + verify versioning, then provision a
# SCOPED SERVICE ACCOUNT (not a full IAM user — see RENDERER-DIFF.md for why
# that is sufficient here) that hub/board/proxy actually use.
#
# `rc` verb map (plan 260915-2104 phase 4/5), ported against the documented
# map + the drake-dev trial script, WITHOUT a live rc.6 verb spike (operator
# run required before a real cutover — same caveat as rc-scripts.ts):
#   mc alias set              -> rc alias set
#   mc mb -p                  -> rc bucket create
#   mc version enable/info    -> rc bucket version enable / info --json
#   mc admin policy create    -> rc admin policy create
#   mc admin user svcacct add/info -> rc admin service-account create/info
#
# Idempotent: safe to run on every install.sh re-run and --upgrade.
set -eu

: "${RUSTFS_ROOT_USER:?RUSTFS_ROOT_USER is required}"
: "${RUSTFS_ROOT_PASSWORD:?RUSTFS_ROOT_PASSWORD is required}"
: "${RUSTFS_ACCESS_KEY:?RUSTFS_ACCESS_KEY is required}"
: "${RUSTFS_SECRET_KEY:?RUSTFS_SECRET_KEY is required}"
RUSTFS_BUCKET="${RUSTFS_BUCKET:-privos}"
RUSTFS_URL="${RUSTFS_URL:-http://rustfs:9000}"
POLICY_NAME="privos-rw"
# rc takes the alias from RC_HOST_m (percent-encoded, so any generated secret
# works); the root credential never becomes an rc argv inside this container.
enc() { jq -rn --arg s "$1" '$s|@uri'; }
RC_HOST_m="${RUSTFS_URL%%://*}://$(enc "$RUSTFS_ROOT_USER"):$(enc "$RUSTFS_ROOT_PASSWORD")@${RUSTFS_URL#*://}"
export RC_HOST_m

rc bucket create "m/${RUSTFS_BUCKET}" >/dev/null

rc bucket version enable "m/${RUSTFS_BUCKET}" >/dev/null
version_info=$(rc bucket version info "m/${RUSTFS_BUCKET}" --json)
case "$version_info" in
  *'"status": "Enabled"'*|*'"status":"Enabled"'*) ;;
  *)
    echo "ERROR: RustFS versioning verification failed for ${RUSTFS_BUCKET}" >&2
    exit 1
    ;;
esac

policy_file=$(mktemp)
trap 'rm -f "$policy_file"' EXIT
cat > "$policy_file" <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:*"],
      "Resource": ["arn:aws:s3:::${RUSTFS_BUCKET}*", "arn:aws:s3:::${RUSTFS_BUCKET}*/*"]
    }
  ]
}
POLICY

rc admin policy create m/ "$POLICY_NAME" "$policy_file" >/dev/null

# Idempotent: skip creation if this access key is already provisioned as a
# service account under the root user (re-run / --upgrade path).
if rc admin service-account info m/ "$RUSTFS_ACCESS_KEY" >/dev/null 2>&1; then
  echo "RUSTFS_PROVISIONED (existing) access_key=${RUSTFS_ACCESS_KEY} bucket=${RUSTFS_BUCKET} policy=${POLICY_NAME}"
else
  rc admin service-account create --policy "$policy_file" -- m/ "$RUSTFS_ACCESS_KEY" "$RUSTFS_SECRET_KEY" >/dev/null
  rc admin service-account info m/ "$RUSTFS_ACCESS_KEY" >/dev/null
  echo "RUSTFS_PROVISIONED access_key=${RUSTFS_ACCESS_KEY} bucket=${RUSTFS_BUCKET} policy=${POLICY_NAME}"
fi
