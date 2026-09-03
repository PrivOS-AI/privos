# Signing the self-hosted bundle

`versions.json` and `compose.yml` are the two files an install host trusts
without re-deriving them itself — `install.sh` verifies both with
[minisign](https://jedisct1.github.io/minisign/) **before** it writes any
state or pulls any image. The R2/GitHub Release bucket that serves them is
treated as untrusted transport; the signature is the actual trust boundary.

## Active signing key (generated 2026-08-27)

The bundle's embedded public key is the **production** key
(`MINISIGN_PUBLIC_KEY_IS_DEV_ONLY="false"` in `install.sh`):

```
RWQVDoIkZD9NNKyCJhKYcl7tGiAAys+Pp+PvLH1DJ5Ai1Ze7nTzm3cK2
```

- **Secret key:** `~/.ssh/privos-minisign.key` (mode 0600, on the operator's
  machine, per user decision — kept alongside `mt-management`). It is
  **un-passphrased** so publishing is scriptable; treat the machine as the
  trust root and back the key up to an offline vault. NEVER commit it.
- **Public key:** `~/.ssh/privos-minisign.pub`.

Publish (signs with this key, uploads the Release):

```bash
publish-self-hosted-bundle.sh --stack-version <v7.15.x-tenant.N> \
  --minisign-key ~/.ssh/privos-minisign.key --yes
```

> **Hardening note:** for a higher-assurance root of trust, regenerate on an
> offline machine with a passphrase (`minisign -G -p pub -s key`), store the
> secret in a hardware token / offline vault, re-embed the new public key, and
> re-publish. The current key is adequate for early access but lives on a
> developer machine.

### Legacy: how to generate an offline key (reference)

```bash
minisign -G -p privos-self-hosted.pub -s privos-self-hosted.key
# prompts for a password protecting the secret key — the root of trust for
# every self-hosted install that will ever exist.
```

- `privos-self-hosted.pub` — embed the single base64 line (after
  `untrusted comment: ...`) into `install.sh` (`MINISIGN_PUBLIC_KEY=`) and
  into `docs/self-hosted-install.md`. Both copies must match, byte for byte,
  or an install host verifying against a stale doc copy would falsely
  distrust a legitimately re-signed bundle. `publish-self-hosted-bundle.sh`
  is **not** a third copy to keep in sync — it reads `MINISIGN_PUBLIC_KEY`
  straight out of `install.sh` at run time
  (`resolve_public_key_from_install_sh`), both for its `--check` verification
  and as a post-sign sanity check that the `--minisign-key` it was just given
  actually produces a signature `install.sh` would trust. There are exactly
  two places to update on rotation: `install.sh` and the docs.
- `privos-self-hosted.key` — never touches a fleet node or this repository.
  Only `publish-self-hosted-bundle.sh`, run by a human with the password, may
  use it (see that script's `--check` mode for a dry run that never touches
  the key).
- Rotation: if the key is ever suspected compromised, generate a new pair,
  re-sign the current `versions.json`/`compose.yml`, update BOTH embedded
  copies (`install.sh` + docs) in the same release, and treat every previously
  published signature as untrusted going forward — `install.sh` has no
  key-rotation/trust-on-first-use logic, it hardcodes exactly one public key.

## DEV-ONLY scaffold keypair (tests only)

A throwaway, un-passphrased keypair lives at `infra/self-hosted/.secrets/`
(gitignored) and is used **only** by the `tests/` signature fixtures. It is
**not** embedded in `install.sh` any more (the production key above is), and
`MINISIGN_PUBLIC_KEY_IS_DEV_ONLY` is `false`. The `--allow-dev-signing-key` /
`PRIVOS_ALLOW_DEV_KEY=1` escape hatch remains in `install.sh` for local test
builds that deliberately re-embed a dev key. Regenerate the fixture key with:

```bash
minisign -G -f -W -p infra/self-hosted/.secrets/dev-minisign.pub \
  -s infra/self-hosted/.secrets/dev-minisign.key \
  -c "PrivOS self-hosted bundle DEV-ONLY signing key (tests only)"
```

## What minisign covers, and what it does not

`install.sh` minisig-verifies `compose.yml` and `versions.json` directly.
`minio-init.sh`, `docker-user-rules.sh`, `LICENSE`, `NOTICE`,
`OPEN-SOURCE-NOTICES`, `rocketchat-upstream-files.txt`, and `TRADEMARK.md`
are **not** separately minisig-signed — they are hash-pinned instead:
`versions.json`'s `files{}` block (itself inside the signature) carries a
sha256 for each, and `install.sh` (`verify_bundle_integrity`) checks every one
of them against that hash *before* any is installed, mounted into a
container, executed as root, or (the five license/notice files) presented to
the operator as the text that was actually signed. Treat a change to any of
them the same as a change to `compose.yml`: it only takes effect once
`publish-self-hosted-bundle.sh` re-hashes it into a freshly signed
`versions.json`.

**`install.sh` itself is not minisig-signed.** It is fetched over
`https://github.com/PrivOS-AI/privos/releases/latest/download/install.sh`
(TLS-from-GitHub, no application-level integrity check) and is the thing
that *performs* the minisign verification —
it cannot verify itself. The minisign boundary protects the bundle
(`compose.yml`, `versions.json`, and by extension `minio-init.sh`,
`docker-user-rules.sh`, `LICENSE`, `NOTICE`, `OPEN-SOURCE-NOTICES`,
`rocketchat-upstream-files.txt`, and `TRADEMARK.md`) it downloads and runs;
TLS is the only protection on `install.sh` in transit. An operator who wants
a stronger guarantee on
`install.sh` itself should download it, verify its sha256 out-of-band (e.g.
against a value published on a different channel), and run the local copy
instead of piping directly from `curl`.

## Before each publish

1. Sign with the production key: `--minisign-key ~/.ssh/privos-minisign.key`
   (never the tests-only key in `.secrets/`).
2. `publish-self-hosted-bundle.sh --check` on the assembled bundle must pass:
   signatures, real `@sha256` digests, file hashes, and no leftover
   `__PRIVOS_STACK_VERSION__` / `__SBOM_LICENSE_INVENTORY__` tokens in
   `OPEN-SOURCE-NOTICES` (use `syft`, or `--skip-sbom` only with a reason).
3. Confirm `infra/self-hosted/.secrets/` and `~/.ssh/privos-minisign.key` are
   not referenced anywhere in the published artifacts.
