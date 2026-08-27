#!/usr/bin/env bash
# Unit tests for install.sh's verify_signature(): happy path against the DEV
# scaffold keypair (SIGNING.md) and a tamper path (content changed after
# signing must fail closed).
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SELF_DIR/helpers.sh"
# shellcheck source=/dev/null
source "$SELF_DIR/../install.sh"
set +e

if ! command -v minisign >/dev/null 2>&1; then
  echo "# SKIP: minisign not installed"
  exit 0
fi

DEV_KEY="$SELF_DIR/../.secrets/dev-minisign.key"
DEV_PUB="$SELF_DIR/../.secrets/dev-minisign.pub"
if [[ ! -f "$DEV_KEY" || ! -f "$DEV_PUB" ]]; then
  echo "# SKIP: DEV scaffold keypair not present at infra/self-hosted/.secrets/ (see SIGNING.md)"
  exit 0
fi

# install.sh embeds the DEV public key by default already, but pin it
# explicitly here so this test never silently passes against a key mismatch.
MINISIGN_PUBLIC_KEY="$(tail -n1 "$DEV_PUB")"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "hello privos self-hosted bundle" > "$WORK/artifact.txt"
minisign -S -s "$DEV_KEY" -m "$WORK/artifact.txt" -t "test artifact" >/dev/null 2>&1

( verify_signature "$WORK/artifact.txt" ) >/dev/null 2>&1
rc=$?
assert_status 0 "$rc" "verify_signature: accepts a correctly signed file"

# Tamper: mutate the content after signing without re-signing.
echo "tampered content" >> "$WORK/artifact.txt"
( verify_signature "$WORK/artifact.txt" ) >/dev/null 2>&1
rc=$?
assert_status 1 "$rc" "verify_signature: rejects a tampered file (signature no longer matches)"

# Missing signature file entirely.
rm -f "$WORK/artifact.txt.minisig"
( verify_signature "$WORK/artifact.txt" ) >/dev/null 2>&1
rc=$?
assert_status 1 "$rc" "verify_signature: rejects a file with no .minisig at all"

# Wrong public key: sign with the DEV key, verify against an unrelated
# ephemeral key — a well-formed key that simply isn't the signer.
echo "hello again" > "$WORK/artifact2.txt"
minisign -S -s "$DEV_KEY" -m "$WORK/artifact2.txt" -t "test artifact 2" >/dev/null 2>&1
minisign -G -W -f -p "$WORK/other.pub" -s "$WORK/other.key" >/dev/null 2>&1
# shellcheck disable=SC2034 # read by verify_signature() in the sourced install.sh
MINISIGN_PUBLIC_KEY="$(tail -n1 "$WORK/other.pub")"
( verify_signature "$WORK/artifact2.txt" ) >/dev/null 2>&1
rc=$?
assert_status 1 "$rc" "verify_signature: rejects a signature valid under a different key"

report_and_exit
