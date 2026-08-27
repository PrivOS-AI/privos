# PrivOS — self-hosted installer & release bundle

> 🚧 **Pre-release — do NOT `curl | bash` yet.** The bundle is not production-signed,
> image digests are placeholders, and the backing container images / control-plane
> routes are not yet public or deployed. Published for review and integration only.

Single-host Docker Compose install of **privos-hub + privos-sandbox** (mongo, redis,
minio, board, proxy, VM pool) with host port-conflict detection, loopback-only exposure
of internal services, minisign-verified bundle, and digest-pinned images. After install
the hub prints a **license request code** to redeem at
`https://client.privos.io/self-hosted/activate`.

## Intended usage (once released)

```bash
curl -fsSL https://github.com/PrivOS-AI/privos/releases/latest/download/install.sh | sudo bash
# overrides: --hub-port N  --vm-port-range A-B  --dir /opt/privos  --yes
#            --with-knowledge-vector  --with-local-runtime  --upgrade  --uninstall [--purge]
```

## Contents

| File | Purpose |
|---|---|
| `install.sh` | Preflight, port checks, secret gen, MinIO init, DOCKER-USER rules, **minisign verify**, digest-pinned pull, wait + print request code |
| `compose.yml` | Fleet-renderer-matched stack; only the hub port public, sandbox plane on loopback; `knowledge-vector` / `local-runtime` opt-in profiles |
| `env.template` | Documented knobs; secrets generated locally by the installer |
| `minio-init.sh` | Bucket + scoped service account (mirrors the fleet provisioner) |
| `docker-user-rules.sh` | Firewall rules so a later `ports:` edit can't expose the sandbox plane |
| `versions.json` | Bundle version + `@sha256` image digests (resolved at publish) |
| `publish-self-hosted-bundle.sh` | Resolve digests, sign with minisign, publish to GitHub |
| `SIGNING.md` | How the bundle is signed; the embedded public key |
| `tests/` | Bash unit tests (port-check, env render, signature verify) + CI |

## Security

The installer verifies a **minisign** signature over `versions.json` + `compose.yml`
before use, and pulls images by immutable `@sha256` digest. Only the hub port is
published on `0.0.0.0`; board, proxy, MinIO and the VM pool bind `127.0.0.1`. See
`SIGNING.md` for the public key. The current published key is **DEV-only**; production
releases are re-signed with a securely held key.

## License

PrivOS is licensed under the **PrivOS Community License 1.0** (see [`LICENSE`](./LICENSE)), a
source-available license derived from the Elastic License 2.0. It is **not an Open Source license**.

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
