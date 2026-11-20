# Signing the self-hosted bundle

`versions.json` and `compose.yml` (plus `compose.desktop.yml` on macOS and Windows) are the files
an install host trusts without re-deriving them itself — `install.sh` (`install.ps1` on Windows) verifies them with
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
  actually produces a signature `install.sh` would trust. On rotation, update
  `install.sh`, `install.ps1` (`MinisignPublicKey`, which the publish script does not read) and the docs.
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

A throwaway, un-passphrased keypair lives at `.secrets/`
(gitignored) and is used **only** by the `tests/` signature fixtures. It is
**not** embedded in `install.sh` any more (the production key above is), and
`MINISIGN_PUBLIC_KEY_IS_DEV_ONLY` is `false`. The `--allow-dev-signing-key` /
`PRIVOS_ALLOW_DEV_KEY=1` escape hatch remains in `install.sh` for local test
builds that deliberately re-embed a dev key. Regenerate the fixture key with:

```bash
minisign -G -f -W -p .secrets/dev-minisign.pub \
  -s .secrets/dev-minisign.key \
  -c "PrivOS self-hosted bundle DEV-ONLY signing key (tests only)"
```

## What minisign covers, and what it does not

`install.sh` minisig-verifies `compose.yml` and `versions.json` directly.
`rustfs-init.sh`, `docker-user-rules.sh`, `LICENSE`, `NOTICE`,
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
(`compose.yml`, `versions.json`, and by extension `rustfs-init.sh`,
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
3. Confirm `.secrets/` and `~/.ssh/privos-minisign.key` are
   not referenced anywhere in the published artifacts.

## Container image signing (cosign)

minisign covers the bundle files. The PrivOS-built container images
(`ghcr.io/privos-ai/*` only: hub, sandbox-board, sandbox-proxy, sandbox-vm,
app-cluster, publisher, netguard) are signed separately with
[cosign](https://github.com/sigstore/cosign). Third-party images in the bundle
(mongo, redis, rustfs, weaviate) are not signed by PrivOS; they are pinned by
digest in the minisign-signed `compose.yml` / `versions.json`.

> **Status:** `publish-self-hosted-bundle.sh --yes` signs and attests every
> pinned `ghcr.io/privos-ai/*` image from the first release published after this
> change. Releases published before it carry no cosign signature. Customer verify
> commands: [`VERIFY-IMAGES.md`](VERIFY-IMAGES.md) (also a Release asset).
> `install.sh` does not verify cosign signatures: the minisign-signed
> `versions.json` pins the image digests and the sha256 of `cosign.pub`.

### Active image signing key (generated 2026-11-20)

- Key pair: cosign v2.6.5, ECDSA P-256, generated 2026-11-20.
- Public key: [`cosign.pub`](cosign.pub) in this repository, also uploaded to
  every GitHub Release once signing is live.
- SHA-256 of `cosign.pub` (the file as published):
  `cf0266cb56f5dad90147a5feaad7a5a423718461d4ccc48017af95c4480d46c5`
- Secret key: `~/.ssh/privos-cosign.key` (mode 0600, cosign-encrypted) with its
  password in `~/.ssh/privos-cosign.password` (mode 0600), on the two PrivOS
  release operator machines only, plus an encrypted offline backup. NEVER
  commit either file.

Check the key you downloaded before trusting anything it verifies:

```bash
sha256sum cosign.pub
# cf0266cb56f5dad90147a5feaad7a5a423718461d4ccc48017af95c4480d46c5  cosign.pub
```

### No transparency log

PrivOS does **not** upload signatures to the public Rekor transparency log.
Signing uses `--tlog-upload=false`, so verification must pass
`--insecure-ignore-tlog=true`. The trust root is `cosign.pub` alone; there is
no public log entry to cross-check. The flag name says "insecure" because
cosign cannot prove *when* a signature was made, not because the signature is
weaker.

### What is signed

For each image tag in a release:

- the multi-arch index digest pinned in `versions.json`, signed with
  `cosign sign` (children included);
- a CycloneDX SBOM per platform image (`linux/amd64`, `linux/arm64`),
  generated by syft and attached with `cosign attest --type cyclonedx`. The
  same SBOM files are uploaded to the GitHub Release.

### Rotation

- Rotate yearly and immediately on suspected compromise.
- On rotation: generate a new pair, commit the new `cosign.pub`, add the old
  key to the list below with its retirement date, and re-sign the images of
  every release that is still supported.
- After a compromise, treat every signature made with the old key as
  untrusted.

Past image signing public keys (newest first):

| Key SHA-256 (of `cosign.pub`) | Active from | Retired | Reason |
|---|---|---|---|
| `cf0266cb56f5dad90147a5feaad7a5a423718461d4ccc48017af95c4480d46c5` | 2026-11-20 | (active) | |
