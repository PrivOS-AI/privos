#!/usr/bin/env bash
# Unit tests for publish-self-hosted-bundle.sh's cosign prerequisites guard:
# a non---check run refuses a missing cosign, key, password file, a password
# file that is not mode 600, a missing committed cosign.pub, and (on --yes) a
# host key that does not pair with the committed cosign.pub. The password must
# reach cosign only through its environment, never argv. No real key is used.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SELF_DIR/helpers.sh"
# shellcheck source=/dev/null
source "$SELF_DIR/../publish-self-hosted-bundle.sh"
set +e

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Fake cosign: `public-key` prints $FAKE_PUB; every call logs its argv and
# whether COSIGN_PASSWORD was set to the expected value.
cat > "$WORK/cosign" <<'FAKE'
#!/usr/bin/env bash
printf 'argv:%s\n' "$*" >> "$FAKE_LOG"
[[ "${COSIGN_PASSWORD:-}" == "fake-pass" ]] && echo "env:password-set" >> "$FAKE_LOG"
[[ "$1" == public-key ]] && cat "$FAKE_PUB"
exit 0
FAKE
chmod +x "$WORK/cosign"
mkdir -p "$WORK/bundle"
printf 'PUB-A\n' > "$WORK/bundle/cosign.pub"
printf 'PUB-A\n' > "$WORK/host.pub"
printf 'fake-key\n' > "$WORK/cosign.key"
printf 'fake-pass\n' > "$WORK/cosign.password"
chmod 600 "$WORK/cosign.password"
export FAKE_LOG="$WORK/fake.log" FAKE_PUB="$WORK/host.pub"

# shellcheck disable=SC2034  # globals read by the sourced require_signing_prereqs
guard() {  # run require_signing_prereqs in a subshell; print exit code + stderr
  local out
  out="$( (COSIGN="$WORK/cosign"; COSIGN_KEY="$WORK/cosign.key"; COSIGN_PASSWORD_FILE="$WORK/cosign.password"
           BUNDLE_DIR="$WORK/bundle"; DRY_RUN="$1"; require_signing_prereqs) 2>&1)"
  printf '%s|%s' "$?" "$out"
}

r="$(guard false)"; assert_eq "0" "${r%%|*}" "--yes: matching key pair passes"
assert_contains "$r" "pairs with the committed cosign.pub" "--yes: pairing is checked"
assert_contains "$(cat "$FAKE_LOG")" "env:password-set" "password reaches cosign via its environment"
assert_not_contains "$(cat "$FAKE_LOG")" "fake-pass" "password never appears in cosign argv"

: > "$FAKE_LOG"
r="$(guard true)"; assert_eq "0" "${r%%|*}" "dry run: prerequisites present passes"
assert_eq "" "$(cat "$FAKE_LOG")" "dry run: cosign (and the key) is never invoked"

printf 'PUB-B\n' > "$WORK/host.pub"
r="$(guard false)"; assert_eq "1" "${r%%|*}" "--yes: key not pairing with committed cosign.pub is refused"
assert_contains "$r" "does not pair" "--yes: mismatch message"
printf 'PUB-A\n' > "$WORK/host.pub"

chmod 644 "$WORK/cosign.password"
r="$(guard true)"; assert_eq "1" "${r%%|*}" "password file mode 644 is refused"
assert_contains "$r" "must be mode 600" "mode message"
chmod 600 "$WORK/cosign.password"

mv "$WORK/bundle/cosign.pub" "$WORK/pub.bak"
r="$(guard true)"; assert_eq "1" "${r%%|*}" "missing committed cosign.pub is refused"
mv "$WORK/pub.bak" "$WORK/bundle/cosign.pub"

mv "$WORK/cosign.key" "$WORK/key.bak"
r="$(guard true)"; assert_eq "1" "${r%%|*}" "missing cosign key is refused"
mv "$WORK/key.bak" "$WORK/cosign.key"

mv "$WORK/cosign.password" "$WORK/pw.bak"
r="$(guard true)"; assert_eq "1" "${r%%|*}" "missing password file is refused"
mv "$WORK/pw.bak" "$WORK/cosign.password"

chmod -x "$WORK/cosign"
r="$(guard true)"; assert_eq "1" "${r%%|*}" "non-executable cosign is refused"
chmod +x "$WORK/cosign"

# The committed key the bundle ships is hashed into the signed versions.json.
found=0
for f in "${HASHED_FILES[@]}"; do [[ "$f" == cosign.pub ]] && found=1; done
assert_eq "1" "$found" "cosign.pub is in HASHED_FILES (vouched for by versions.json)"

report_and_exit
