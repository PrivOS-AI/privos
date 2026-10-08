#!/usr/bin/env bash
# Guards install.sh against bash 4+ constructs. macOS ships bash 3.2 as
# /bin/bash and `curl | bash` runs install.sh with it, so the WHOLE file must
# parse and behave under 3.2 — it is parsed before any OS branch runs.
#
#   1. grep gate: bash-4+ constructs (and GNU-only flags that have no macOS
#      equivalent) must not appear in install.sh.
#   2. behavioural checks of the helpers that used to rely on bash 4+/5 quoting
#      and array semantics; they run in whatever bash executes this file.
#   3. when a bash 3.2 binary is available ($BASH32, /bin/bash on a Mac, or
#      bash-3.2 on PATH): `bash -n install.sh` and a re-run of (2) under it.
#      Otherwise a visible SKIP line is printed.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SH="$SELF_DIR/../install.sh"
# shellcheck source=/dev/null
source "$SELF_DIR/helpers.sh"
# shellcheck source=/dev/null
source "$INSTALL_SH"
set +e

echo "# running under bash ${BASH_VERSION}"

# --- 1. grep gate ------------------------------------------------------------

code_only="$(grep -vE '^[[:space:]]*#' "$INSTALL_SH")"

gate() {  # gate <extended regex> <message>
  local hits
  hits="$(grep -nE -- "$1" <<<"$code_only" || true)"
  if [[ -z "$hits" ]]; then
    assert_eq "" "" "bash32 gate: no ${2}"
  else
    assert_eq "" "$hits" "bash32 gate: no ${2}"
  fi
}

gate 'declare[[:space:]]+-[A-Za-z]*[Ag]|local[[:space:]]+-[A-Za-z]*A|typeset[[:space:]]+-[A-Za-z]*A' "associative array / declare -g (bash 4+)"
gate '(^|[^A-Za-z_])(mapfile|readarray)([^A-Za-z_]|$)' "mapfile/readarray (bash 4+)"
gate '\$\{[A-Za-z_][A-Za-z_0-9]*(,,|\^\^|,|\^)[^}]*\}' "case-modification expansion \${v,,} \${v^^} (bash 4+)"
gate '\|&' "|& pipe (bash 4+)"
gate ';;&|;&' "case fallthrough ;;& ;& (bash 4+)"
gate '(^|[[:space:]])read[[:space:]].*-[A-Za-z]*i[[:space:]]' "read -i (bash 4+)"
gate 'local[[:space:]]+-[A-Za-z]*n|declare[[:space:]]+-[A-Za-z]*n' "namerefs (bash 4.3+)"
gate '\[\[[[:space:]]+-v[[:space:]]' "[[ -v var ]] (bash 4.2+)"
gate '(^|[^A-Za-z_])(coproc|wait[[:space:]]+-n)([^A-Za-z_]|$)' "coproc / wait -n (bash 4+)"
gate '\$\{?(EPOCHSECONDS|EPOCHREALTIME|BASHPID|SRANDOM)' "bash 5 variables"
gate '\[-[0-9]+\]' "negative array subscript (bash 4.3+)"
gate '&>>|\$\{[A-Za-z_]+@[QEPAa]\}' "&>> / \${v@Q} (bash 4+)"
gate 'printf[[:space:]]+(-v[[:space:]]+[A-Za-z_]+\[|.*%\([^)]*\)T)' "printf -v into an array element / %()T (bash 4.2+)"
gate 'read[[:space:]].*-t[[:space:]]+[0-9]*\.[0-9]' "fractional read -t (bash 4+)"
gate 'grep[[:space:]]+(-[A-Za-z]*P|--perl)|sed[[:space:]]+-[A-Za-z]*r[[:space:]]|readlink[[:space:]]+-f|sort[[:space:]]+-[A-Za-z]*V|xargs[[:space:]]+-r|mktemp[[:space:]]+--' "GNU-only grep -P / sed -r / readlink -f / sort -V / xargs -r"

# --- 2. behavioural checks ---------------------------------------------------

# env_quote / env_unquote: the quoting that bash 3.2 reads differently.
q="admin's mailbox 'quoted' twice"
assert_eq "'admin'\\''s mailbox '\\''quoted'\\'' twice'" "$(env_quote "$q")" "env_quote: escapes embedded single quotes"
assert_eq "$q" "$(env_unquote "$(env_quote "$q")")" "env_unquote: exact inverse of env_quote"
assert_eq "plain" "$(env_unquote "$(env_quote "plain")")" "env_unquote: plain value round-trips"
assert_eq "a b&c" "$(env_unquote "$(env_quote "a b&c")")" "env_unquote: spaces and & round-trip"

# Port tables are indexed arrays keyed by port number.
LISTEN_PID=(); LISTEN_CMD=()
LISTEN_PID[3000]=42; LISTEN_CMD[3000]=node
assert_eq "42" "${LISTEN_PID[3000]:-}" "LISTEN_PID: indexed by port number"
assert_eq "" "${LISTEN_PID[8556]:-}" "LISTEN_PID: unset port reads empty under set -u"
assert_eq "node" "${LISTEN_CMD[3000]:-}" "LISTEN_CMD: indexed by port number"

# pick_free_port with an empty avoid list must not trip `set -u` on an empty array.
port_is_free() { return 0; }
assert_eq "40000" "$(pick_free_port 40000)" "pick_free_port: no avoid list, bash 3.2 empty-array safe"

# to_lower / version_ge
assert_eq "example.com" "$(to_lower "ExAmPlE.COM")" "to_lower: lowercases without \${v,,}"
version_ge "v2.29.1-desktop.1" "2.27.0"; assert_status 0 "$?" "version_ge: 2.29.1-desktop.1 >= 2.27.0"
version_ge "2.27.0" "2.27.0";            assert_status 0 "$?" "version_ge: equal versions pass"
version_ge "2.26.9" "2.27.0";            assert_status 1 "$?" "version_ge: 2.26.9 < 2.27.0"
version_ge "1.44" "1.45";                assert_status 1 "$?" "version_ge: API 1.44 < 1.45"
version_ge "1.47" "1.45";                assert_status 0 "$?" "version_ge: API 1.47 >= 1.45"
version_ge "14.5" 13;                    assert_status 0 "$?" "version_ge: macOS 14.5 >= 13"
version_ge "12.7.6" 13;                  assert_status 1 "$?" "version_ge: macOS 12.7.6 < 13"
version_ge "" "1.45";                    assert_status 1 "$?" "version_ge: empty version fails"
version_ge "abc" "1.45";                 assert_status 1 "$?" "version_ge: non-numeric version fails"
version_ge "2.100.0" "2.27.0";           assert_status 0 "$?" "version_ge: compares numerically, not lexically"

# hex_to_base64url: bytes including NUL must survive printf '%b' on this bash.
assert_eq "AP8QIA" "$(hex_to_base64url "00ff1020")" "hex_to_base64url: leading NUL byte survives"
assert_eq "_-A" "$(hex_to_base64url "ffe0")" "hex_to_base64url: base64url alphabet, no padding"

if command -v openssl >/dev/null 2>&1 && openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null | openssl ec -noout -text >/dev/null 2>&1; then
  generate_vapid_keypair
  assert_eq "43" "${#VAPID_PRIVATE_KEY}" "generate_vapid_keypair: private key is 32 bytes base64url"
  assert_eq "87" "${#VAPID_PUBLIC_KEY}" "generate_vapid_keypair: public key is 65 bytes base64url"
  case "$VAPID_PUBLIC_KEY" in B*) assert_eq "ok" "ok" "generate_vapid_keypair: public key starts with the 0x04 uncompressed marker" ;; *) assert_eq "B*" "$VAPID_PUBLIC_KEY" "generate_vapid_keypair: public key starts with the 0x04 uncompressed marker" ;; esac
else
  echo "# SKIP: openssl with prime256v1 not available for the VAPID keypair check"
fi

# vapid_hex_from_ec_text: both OpenSSL layouts (extra leading 00 on priv) parse.
sample="Private-Key: (256 bit)
priv:
    00:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:
    89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:
    89
pub:
    04:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:
    00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:
    00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:
    00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:
    ab
ASN1 OID: prime256v1
NIST CURVE: P-256"
pair="$(printf '%s\n' "$sample" | vapid_hex_from_ec_text)"
vp="${pair%%$'\n'*}"; vq="${pair##*$'\n'}"
assert_eq "64" "${#vp}" "vapid_hex_from_ec_text: private scalar trimmed to 32 bytes"
assert_eq "130" "${#vq}" "vapid_hex_from_ec_text: public point is 65 bytes"
vapid_pair_valid "$vp" "$vq"; assert_status 0 "$?" "vapid_pair_valid: accepts a well-formed pair"
vapid_pair_valid "" "";       assert_status 1 "$?" "vapid_pair_valid: rejects empty output"
vapid_pair_valid "$(printf '0%.0s' $(seq 1 64))" "$vq"; assert_status 1 "$?" "vapid_pair_valid: rejects an all-zero scalar"
assert_eq "" "$(printf '' | vapid_hex_from_ec_text | head -n1)" "vapid_hex_from_ec_text: unparseable output yields an empty scalar (not zeros)"

# --- 3. a real bash 3.2, when there is one -----------------------------------

B32=""
if [[ -n "${BASH32:-}" && -x "${BASH32}" ]]; then B32="$BASH32"
elif [[ "${BASH_VERSINFO[0]}" == "3" ]]; then B32="$BASH"
elif [[ -x /bin/bash ]] && /bin/bash --version 2>/dev/null | head -n1 | grep -q 'version 3\.2'; then B32=/bin/bash
elif command -v bash-3.2 >/dev/null 2>&1; then B32="$(command -v bash-3.2)"
fi

if [[ -z "$B32" ]]; then
  echo "# SKIP: no bash 3.2 binary found (set BASH32=/path/to/bash-3.2, or run on macOS) — bash -n install.sh was NOT run under 3.2"
elif [[ -n "${PRIVOS_COMPAT_INNER:-}" ]]; then
  :
else
  echo "# bash 3.2 binary: ${B32} ($("$B32" --version | head -n1))"
  "$B32" -n "$INSTALL_SH" 2>&1
  assert_status 0 "$?" "bash -n install.sh parses under bash 3.2"
  if [[ "${BASH_VERSINFO[0]}" != "3" ]]; then
    inner_out="$(PRIVOS_COMPAT_INNER=1 "$B32" "$0" 2>&1)"; inner_rc=$?
    assert_status 0 "$inner_rc" "behavioural checks pass under bash 3.2"
    [[ "$inner_rc" -eq 0 ]] || printf '%s\n' "$inner_out" >&2
  fi
fi

report_and_exit
