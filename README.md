# PrivOS — self-hosted installer & release bundle

**PrivOS is [fair-code](https://faircode.io):** free to run for your own team (up to 10 human users),
source-available installer, commercial rights reserved. Not open source — see [License](#license).

> 🚧 **Pre-release — do NOT `curl | bash` yet.** The bundle is not production-signed,
> image digests are placeholders, and the backing container images / control-plane
> routes are not yet public or deployed. Published for review and integration only.

Single-host Docker Compose install of **privos-hub + privos-sandbox** (mongo, redis,
minio, board, proxy, VM pool) with host port-conflict detection, loopback-only exposure
of internal services, minisign-verified bundle, and digest-pinned images. After install
the hub prints a **license request code** to redeem at
`https://client.privos.io/self-hosted/activate`.

## ⚠️ WARNING: Early access

PrivOS is in a state of heavy development. The self-hosted path in this repository is
new and still has rough edges — we know, and we're working on it. For now, consider this
an **early access** release: expect breaking changes between versions, read the release
notes before `--upgrade`, and keep backups of `/opt/privos` (the installer never deletes
data unless you pass `--uninstall --purge`).

## Intended usage (once released)

```bash
curl -fsSL https://github.com/PrivOS-AI/privos/releases/latest/download/install.sh | sudo bash
# overrides: --hub-port N  --vm-port-range A-B  --dir /opt/privos  --yes (implies license acceptance)
#            --with-knowledge-vector  --with-local-runtime  --upgrade  --uninstall [--purge]
```

## Contents

| File | Purpose |
|---|---|
| `install.sh` | Preflight, port checks, license acceptance, secret gen, MinIO init, DOCKER-USER rules, **minisign verify**, digest-pinned pull, wait + print request code |
| `compose.yml` | Fleet-renderer-matched stack; only the hub port public, sandbox plane on loopback; `knowledge-vector` / `local-runtime` opt-in profiles |
| `env.template` | Documented knobs; secrets generated locally by the installer |
| `minio-init.sh` | Bucket + scoped service account (mirrors the fleet provisioner) |
| `docker-user-rules.sh` | Firewall rules so a later `ports:` edit can't expose the sandbox plane |
| `versions.json` | Bundle version + `@sha256` image digests + file hashes (resolved at publish) |
| `publish-self-hosted-bundle.sh` | Resolve digests, sign with minisign, publish a GitHub Release |
| `SIGNING.md` | How the bundle is signed; the embedded public key |
| `LICENSE` | PrivOS Community License 1.0 |
| `tests/` | Bash unit tests (port-check, env render, signature/hash verify, license gate) + CI |

## Security

The installer verifies a **minisign** signature over `versions.json` + `compose.yml`, checks
every other bundle file against the sha256 hashes carried in the signed `versions.json`, and
pulls images by immutable `@sha256` digest. Only the hub port is published on `0.0.0.0`;
board, proxy, MinIO and the VM pool bind `127.0.0.1`. See `SIGNING.md` for the public key.
The current published key is **DEV-only**; production releases are re-signed with a securely
held key. Found a vulnerability? Please email `security@privos.ai` rather than opening a
public issue.

## Roadmap: open source

PrivOS is **fair-code, not open source, today**. It is distributed under the
[PrivOS Community License 1.0](./LICENSE) — the installer here is source-available, the product
ships as container images, and commercial use beyond the Community tier is reserved. **We intend to publish the PrivOS source code and move
to an open source license in the future.** We have not committed to a date; we will announce
it in this repository when we do. Until then the Community License applies to every release,
and the terms below on contributions are in effect.

## Contributing

At this time, we are **not seeking outside code contributions** — but we very much want your
**issues and feedback**.

AI has made writing code easy. The hard part today is not writing the code, but reviewing
it, keeping quality high, and keeping the product coherent. External code contributions
"donate" the easy part of the job while creating more of the hard part — and while the
source is not yet published, a meaningful code contribution is not even possible.

What we welcome right now:

- **Bug reports** → [open an issue](https://github.com/PrivOS-AI/privos/issues/new/choose)
  (installer failures, port-check false positives, upgrade problems, docs errors).
- **Feedback and feature requests** → [open a discussion](https://github.com/PrivOS-AI/privos/discussions)
  (what you'd need to run PrivOS for your team, what's confusing, what's missing).
- **Big ideas** → a discussion first, before anyone writes code.

We are happy to accept **small, trivially-verified pull requests** to the installer that fix
a real problem. Please refrain from low-value PRs (typo fixes) or PRs larger than a dozen or
so lines; such PRs will be closed with a reference to this guideline.

This policy will change as the project matures and the source is opened. Until then, thank
you for your understanding.

## License

PrivOS is licensed under the **PrivOS Community License 1.0** (see [`LICENSE`](./LICENSE)), a
[fair-code](https://faircode.io) license derived from the Elastic License 2.0: the source of the
installer is available and the software is free to use within the Community tier, while commercial,
hosted-service, and redistribution rights are reserved. It is **not an Open Source license** — like
n8n's Sustainable Use License, it limits *how* the software may be used, which the OSI definition
does not allow.

- **Free Community tier:** production use with up to **10 Active Human Users** per deployment
  (bots, integrations and AI agents never count).
- **More than 10 users:** requires a Commercial License Key from Roxane INC — activate at
  `https://client.privos.io/self-hosted/activate`.
- **Hosted/managed services (SaaS) and commercial redistribution** of PrivOS or modified versions
  require a Partner License.
- Giving an unmodified copy to someone for free, and charging for your own installation or support
  services, is allowed — each deployment is its own licensee.

Portions of PrivOS Hub are derived from Rocket.Chat and remain under the MIT License; third-party
components keep their own licenses (shipped inside the images as `NOTICE` / `OPEN-SOURCE-NOTICES.txt`).
Licensing inquiries: legal@privos.ai · Licensor: Roxane INC (Delaware, USA).
