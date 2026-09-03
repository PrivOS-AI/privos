#!/usr/bin/env bash
# Unit tests for install.sh's bundle integrity chain (C1 fix): every fetched
# bundle file must be verified — compose.yml/versions.json by minisign,
# minio-init.sh/docker-user-rules.sh/LICENSE/NOTICE/OPEN-SOURCE-NOTICES/
# rocketchat-upstream-files.txt/TRADEMARK.md by sha256 recorded INSIDE the
# (signed) versions.json — before any of them is installed, mounted,
# executed, or (LICENSE/NOTICE) presented to the operator as what they
# accepted.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SELF_DIR/helpers.sh"
# shellcheck source=/dev/null
source "$SELF_DIR/../install.sh"
set +e

if ! command -v jq >/dev/null 2>&1; then
  echo "# SKIP: jq not installed"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

printf 'echo hello from docker-user-rules\n' > "$WORK/docker-user-rules.sh"
printf 'echo hello from minio-init\n' > "$WORK/minio-init.sh"
printf 'PrivOS Community License 1.0 (PCL-1.0) — test fixture text\n' > "$WORK/LICENSE"
printf 'PrivOS — NOTICE test fixture text\n' > "$WORK/NOTICE"

real_sha() { sha256_file "$1"; }

# --- sha256_file: sanity (portable helper itself) ---------------------------

if command -v sha256sum >/dev/null 2>&1; then
  expected_hello="$(printf 'hello\n' | sha256sum | awk '{print $1}')"
else
  expected_hello="$(printf 'hello\n' | shasum -a 256 | awk '{print $1}')"
fi
tmp_hello="$WORK/hello.txt"
printf 'hello\n' > "$tmp_hello"
assert_eq "$expected_hello" "$(sha256_file "$tmp_hello")" "sha256_file: matches sha256sum/shasum"

# --- verify_bundle_file_hash: happy path ------------------------------------

jq -n \
  --arg dur "$(real_sha "$WORK/docker-user-rules.sh")" \
  --arg mi "$(real_sha "$WORK/minio-init.sh")" \
  --arg lic "$(real_sha "$WORK/LICENSE")" \
  --arg not "$(real_sha "$WORK/NOTICE")" \
  '{files: {"docker-user-rules.sh": {sha256: $dur}, "minio-init.sh": {sha256: $mi}, "LICENSE": {sha256: $lic}, "NOTICE": {sha256: $not}}}' \
  > "$WORK/versions.json"

( verify_bundle_file_hash "docker-user-rules.sh" "$WORK" "$WORK/versions.json" ) >/dev/null 2>&1
assert_status 0 "$?" "verify_bundle_file_hash: accepts a file matching versions.json's recorded sha256"

( verify_bundle_file_hash "minio-init.sh" "$WORK" "$WORK/versions.json" ) >/dev/null 2>&1
assert_status 0 "$?" "verify_bundle_file_hash: accepts minio-init.sh matching its recorded sha256"

( verify_bundle_file_hash "LICENSE" "$WORK" "$WORK/versions.json" ) >/dev/null 2>&1
assert_status 0 "$?" "verify_bundle_file_hash: accepts LICENSE matching its recorded sha256"

( verify_bundle_file_hash "NOTICE" "$WORK" "$WORK/versions.json" ) >/dev/null 2>&1
assert_status 0 "$?" "verify_bundle_file_hash: accepts NOTICE matching its recorded sha256"

# --- verify_bundle_file_hash: tampered file after hashing -------------------

printf 'echo PWNED — this was not the file that was hashed\n' > "$WORK/docker-user-rules.sh"
out="$(verify_bundle_file_hash "docker-user-rules.sh" "$WORK" "$WORK/versions.json" 2>&1)"
rc=$?
assert_status 1 "$rc" "verify_bundle_file_hash: rejects a tampered docker-user-rules.sh"
assert_contains "$out" "sha256 mismatch" "verify_bundle_file_hash: reports the mismatch reason"
# restore for the next block
printf 'echo hello from docker-user-rules\n' > "$WORK/docker-user-rules.sh"

printf 'echo PWNED — malicious minio-init\n' > "$WORK/minio-init.sh"
( verify_bundle_file_hash "minio-init.sh" "$WORK" "$WORK/versions.json" ) >/dev/null 2>&1
assert_status 1 "$?" "verify_bundle_file_hash: rejects a tampered minio-init.sh"
printf 'echo hello from minio-init\n' > "$WORK/minio-init.sh"

# A tampered LICENSE is just as much a trust-path violation as tampered
# executable code here: an operator must accept the SAME text that was
# signed, not a swapped-in one.
printf 'PrivOS Community License 1.0 — PWNED, terms silently altered\n' > "$WORK/LICENSE"
out="$(verify_bundle_file_hash "LICENSE" "$WORK" "$WORK/versions.json" 2>&1)"
rc=$?
assert_status 1 "$rc" "verify_bundle_file_hash: rejects a tampered LICENSE"
assert_contains "$out" "sha256 mismatch" "verify_bundle_file_hash: names the mismatch for a tampered LICENSE"
printf 'PrivOS Community License 1.0 (PCL-1.0) — test fixture text\n' > "$WORK/LICENSE"

# A tampered NOTICE is the same class of attack: NOTICE states which files
# (LICENSE, NOTICE, OPEN-SOURCE-NOTICES, rocketchat-upstream-files.txt,
# TRADEMARK.md) must be passed on together — an attacker swapping it in
# after signing must be rejected the same way a swapped LICENSE is.
printf 'PrivOS — NOTICE PWNED, obligations silently altered\n' > "$WORK/NOTICE"
out="$(verify_bundle_file_hash "NOTICE" "$WORK" "$WORK/versions.json" 2>&1)"
rc=$?
assert_status 1 "$rc" "verify_bundle_file_hash: rejects a tampered NOTICE"
assert_contains "$out" "sha256 mismatch" "verify_bundle_file_hash: names the mismatch for a tampered NOTICE"
printf 'PrivOS — NOTICE test fixture text\n' > "$WORK/NOTICE"

# --- verify_bundle_file_hash: missing / malformed hash entry ----------------

jq -n '{files: {}}' > "$WORK/versions-empty.json"
( verify_bundle_file_hash "docker-user-rules.sh" "$WORK" "$WORK/versions-empty.json" ) >/dev/null 2>&1
assert_status 1 "$?" "verify_bundle_file_hash: rejects a versions.json with no recorded hash at all"

jq -n '{files: {"docker-user-rules.sh": {sha256: "not-a-real-hash"}}}' > "$WORK/versions-bad.json"
( verify_bundle_file_hash "docker-user-rules.sh" "$WORK" "$WORK/versions-bad.json" ) >/dev/null 2>&1
assert_status 1 "$?" "verify_bundle_file_hash: rejects a malformed (non-hex-64) recorded hash"

# --- verify_bundle_integrity: end-to-end, tamper aborts before use ----------

DEV_KEY="$SELF_DIR/../.secrets/dev-minisign.key"
if [[ -f "$DEV_KEY" ]] && command -v minisign >/dev/null 2>&1; then
  cp "$SELF_DIR/../compose.yml" "$WORK/compose.yml"
  printf 'echo hello from docker-user-rules\n' > "$WORK/docker-user-rules.sh"
  printf 'echo hello from minio-init\n' > "$WORK/minio-init.sh"
  printf 'PrivOS Community License 1.0 (PCL-1.0) — test fixture text\n' > "$WORK/LICENSE"
  printf 'PrivOS — NOTICE test fixture text\n' > "$WORK/NOTICE"
  printf 'OPEN SOURCE AND THIRD-PARTY NOTICES — test fixture text\n' > "$WORK/OPEN-SOURCE-NOTICES"
  printf 'apps/meteor/test-fixture.ts abc123\n' > "$WORK/rocketchat-upstream-files.txt"
  printf '# TRADEMARK — test fixture text\n' > "$WORK/TRADEMARK.md"
  # A minimal, self-consistent versions.json for this scratch dir only.
  jq -n \
    --arg dur "$(real_sha "$WORK/docker-user-rules.sh")" \
    --arg mi "$(real_sha "$WORK/minio-init.sh")" \
    --arg lic "$(real_sha "$WORK/LICENSE")" \
    --arg not "$(real_sha "$WORK/NOTICE")" \
    --arg osn "$(real_sha "$WORK/OPEN-SOURCE-NOTICES")" \
    --arg rcu "$(real_sha "$WORK/rocketchat-upstream-files.txt")" \
    --arg tm "$(real_sha "$WORK/TRADEMARK.md")" \
    '{files: {"docker-user-rules.sh": {sha256: $dur}, "minio-init.sh": {sha256: $mi}, "LICENSE": {sha256: $lic}, "NOTICE": {sha256: $not}, "OPEN-SOURCE-NOTICES": {sha256: $osn}, "rocketchat-upstream-files.txt": {sha256: $rcu}, "TRADEMARK.md": {sha256: $tm}}}' \
    > "$WORK/versions.json"
  minisign -S -s "$DEV_KEY" -m "$WORK/compose.yml" -t "test" >/dev/null 2>&1
  minisign -S -s "$DEV_KEY" -m "$WORK/versions.json" -t "test" >/dev/null 2>&1
  # shellcheck disable=SC2034 # read by verify_signature() in the sourced install.sh
  MINISIGN_PUBLIC_KEY="$(tail -n1 "$SELF_DIR/../.secrets/dev-minisign.pub")"

  ( verify_bundle_integrity "$WORK" ) >/dev/null 2>&1
  assert_status 0 "$?" "verify_bundle_integrity: passes end-to-end when everything is genuine (incl. LICENSE/NOTICE/OPEN-SOURCE-NOTICES/rocketchat-upstream-files.txt/TRADEMARK.md)"

  # Attacker swaps in a malicious docker-user-rules.sh AFTER versions.json was
  # signed — compose.yml/versions.json are still validly signed (an attacker
  # controlling only the transport, not the signing key, can serve those
  # unmodified), but the unsigned file's hash no longer matches.
  printf 'echo PWNED — root-equivalent code the attacker wants to run\n' > "$WORK/docker-user-rules.sh"
  out="$( verify_bundle_integrity "$WORK" 2>&1 )"
  rc=$?
  assert_status 1 "$rc" "verify_bundle_integrity: aborts when docker-user-rules.sh is swapped after signing (C1)"
  assert_contains "$out" "sha256 mismatch" "verify_bundle_integrity: names the mismatch, not a generic failure"
  printf 'echo hello from docker-user-rules\n' > "$WORK/docker-user-rules.sh"

  # Same attack, but on LICENSE — the text an operator's --accept-license /
  # TTY prompt is standing in for must be the SAME text that was signed.
  printf 'PrivOS Community License 1.0 — PWNED, terms silently altered after signing\n' > "$WORK/LICENSE"
  out="$( verify_bundle_integrity "$WORK" 2>&1 )"
  rc=$?
  assert_status 1 "$rc" "verify_bundle_integrity: aborts when LICENSE is swapped after signing"
  assert_contains "$out" "sha256 mismatch" "verify_bundle_integrity: names the mismatch for a swapped LICENSE"
  printf 'PrivOS Community License 1.0 (PCL-1.0) — test fixture text\n' > "$WORK/LICENSE"

  # Same attack, but on NOTICE — it lists which files must be passed on
  # together; a swapped copy could silently drop that obligation.
  printf 'PrivOS — NOTICE PWNED, obligations silently altered after signing\n' > "$WORK/NOTICE"
  out="$( verify_bundle_integrity "$WORK" 2>&1 )"
  rc=$?
  assert_status 1 "$rc" "verify_bundle_integrity: aborts when NOTICE is swapped after signing"
  assert_contains "$out" "sha256 mismatch" "verify_bundle_integrity: names the mismatch for a swapped NOTICE"
  printf 'PrivOS — NOTICE test fixture text\n' > "$WORK/NOTICE"
else
  echo "# SKIP: DEV scaffold keypair or minisign not available for the end-to-end check"
fi

report_and_exit
