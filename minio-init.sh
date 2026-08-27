#!/bin/sh
# shellcheck shell=sh
#
# Runs inside the minio/mc container (docker compose run --rm minio-init /
# the one-shot `minio-init` service in compose.yml). Reproduces
# privos-portal's minio-provisioner.ts for a single-node, single-tenant
# MinIO: create the bucket, enable + verify versioning, then provision a
# SCOPED SERVICE ACCOUNT (not a full IAM user — see RENDERER-DIFF.md for why
# that is sufficient here) that hub/board/proxy actually use.
#
# Idempotent: safe to run on every install.sh re-run and --upgrade.
set -eu

: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
: "${MINIO_ACCESS_KEY:?MINIO_ACCESS_KEY is required}"
: "${MINIO_SECRET_KEY:?MINIO_SECRET_KEY is required}"
MINIO_BUCKET="${MINIO_BUCKET:-privos}"
MINIO_URL="${MINIO_URL:-http://minio:9000}"
POLICY_NAME="privos-rw"

# `--` before positional credentials: a generated secret that happens to
# start with '-' is otherwise parsed as an mc flag and provisioning fails
# intermittently depending on the first character of a random password
# (same failure mode documented in minio-provisioner.ts).
mc alias set -- m "$MINIO_URL" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null

mc mb -p "m/${MINIO_BUCKET}"

mc version enable "m/${MINIO_BUCKET}"
version_info=$(mc version info --json "m/${MINIO_BUCKET}")
case "$version_info" in
  *'"versioning":{"status":"Enabled"'*) ;;
  *)
    echo "ERROR: MinIO versioning verification failed for ${MINIO_BUCKET}" >&2
    exit 1
    ;;
esac

cat > /tmp/privos-bucket-policy.json <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:*"],
      "Resource": ["arn:aws:s3:::${MINIO_BUCKET}*", "arn:aws:s3:::${MINIO_BUCKET}*/*"]
    }
  ]
}
POLICY

mc admin policy create m "$POLICY_NAME" /tmp/privos-bucket-policy.json 2>/dev/null || true

# Idempotent: skip creation if this access key is already provisioned as a
# service account under the root user (re-run / --upgrade path).
if mc admin user svcacct info m "$MINIO_ACCESS_KEY" >/dev/null 2>&1; then
  echo "MINIO_PROVISIONED (existing) access_key=${MINIO_ACCESS_KEY} bucket=${MINIO_BUCKET} policy=${POLICY_NAME}"
else
  # `=`-form binds the value unambiguously even if it starts with '-' (the
  # same dash-leading-secret hazard `--` guards against for positional args).
  mc admin user svcacct add \
    "--access-key=${MINIO_ACCESS_KEY}" \
    "--secret-key=${MINIO_SECRET_KEY}" \
    --policy /tmp/privos-bucket-policy.json \
    m "$MINIO_ROOT_USER"
  echo "MINIO_PROVISIONED access_key=${MINIO_ACCESS_KEY} bucket=${MINIO_BUCKET} policy=${POLICY_NAME}"
fi
