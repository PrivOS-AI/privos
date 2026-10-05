# PrivOS — self-hosted installer & release bundle

**PrivOS is [fair-code](https://faircode.io):** free to run for your own team (up to 10 signed-in users across your company),
source-available installer, commercial rights reserved. Not open source — see [License](#license).

> **Beta — install at your own risk.** PrivOS Community Edition is in a testing phase.
> The installer, images and upgrade path are still changing, and an install or upgrade
> can fail or leave a half-configured host. Before you run it: use a fresh VM or a host
> you can rebuild, keep backups of anything you care about, and expect breaking changes
> between releases. No warranty and no support commitment apply during the beta; report
> problems as GitHub issues, and security issues to security@privos.ai. By running the
> installer you accept these risks.

Single-host Docker Compose install of **privos-hub + privos-sandbox** (mongo, redis,
rustfs, board, proxy, VM pool) with host port-conflict detection, loopback-only exposure
of internal services, minisign-verified bundle, and digest-pinned images. After install
the hub prints an **activation request code**: activation at
`https://client.privos.io/self-hosted/activate` is required before the install is usable —
see [Activation](#activation) below.

## Documentation

Operator guides on the docs site:
[Install](https://docs.privos.ai/guide/self-hosted/install) ·
[Upgrade](https://docs.privos.ai/guide/self-hosted/upgrade) ·
[Backup and restore](https://docs.privos.ai/guide/self-hosted/backup-restore) ·
[Uninstall and FAQ](https://docs.privos.ai/guide/self-hosted/uninstall-faq)

## Operator CLI

`privos` is a separate read-only client for a running sandbox board and hub
(projects, tasks, rooms, messages). It does not install or upgrade the stack.
Build it with Go from [`cli/`](cli/) (`go build -C cli -o privos ./cmd/privos`)
and use [docs/cli/README.md](docs/cli/README.md). API notes for the commands
it calls are in [docs/api/](docs/api/).

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
#            --with-knowledge-vector  --without-app-cluster  --upgrade  --uninstall [--purge]
```

Host prerequisites: Linux x86_64 (arm64 is not supported yet), Docker ≥ 24 with compose v2 (or pass `--install-docker`), and `curl`, `jq`, `minisign`, `openssl` on PATH (Debian/Ubuntu: `apt-get install -y jq minisign`). The installer stops before touching anything if one is missing.

## Activation

Activation is **required** on every Community Edition install: until it completes, nothing
is usable — the UI shows a gate to every user, and the REST API refuses everything except a
small allowlist (login, `info`, public settings, and the activation endpoints themselves).
This is a **free lead-registration gate, not DRM**: the source is public, so an operator
could patch it out, and we're not pretending otherwise — it exists so we know who is running
PrivOS, not to enforce payment. There is no card and no cost to activate.

**Flow:**

1. Finish the setup wizard (or `install.sh` non-interactively). The hub writes a
   `PRV-XXXX-XXXX-XXXX`-format **activation request code** to
   `/var/lib/privos/self-hosted/license-request-code` inside its container; `install.sh`
   prints it and the direct link (`--yes` prints it once and moves on; without `--yes` it
   waits for you, letting you skip with Ctrl-C and finish later).
2. Open `https://client.privos.io/self-hosted/activate#code=<code>`, sign in (or create a
   free account), and confirm. The hub polls for the result and unlocks within one cycle —
   no restart needed. Once activated, the portal lists your install under that account as a
   Community lead (owner email, activation date, hub version).

**Roxane, the default provider.** Once activated, the built-in **Roxane** provider
(`privos-agent-sdk`, models `gauga`/`issus`/`granic`, served by the PrivOS gateway) is the
default — no extra configuration needed to start chatting. It starts with **$0 credit**; the
agent shows a clear top-up message once that runs out, and you top up any time at
`https://client.privos.io`. Roxane cannot be edited or deleted, in the UI or through the API
— the hub enforces that server-side.

**Custom providers.** The onboarding "AI models" step (also reachable later from Admin) lets
you review providers and add your own: any **publicly reachable** Anthropic-/OpenAI-compatible
endpoint, tested and optionally set as the default in place of Roxane. `env.template`'s
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `PRIVOS_LLM_BASE_URL` pre-seed one automatically on
first boot if you'd rather set it before ever opening the UI — see the comments there. A
provider on a **private/LAN address** (including a fully offline host) is a separate path —
see "LAN / private LLM endpoints" in `env.template`.

**Upgrading an existing unlicensed install.** An install that predates this gate is activated
exactly once on upgrade — the same request-code flow above, run a single time. Its `.env` BYO
key (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`), if it pointed at a **publicly reachable** endpoint,
reappears afterwards as a regular custom provider, and — if no default provider was chosen yet
— becomes the default, so the agent keeps answering with your own key. A BYO key pointing at a
**private/LAN address** needs a sandbox image with the LAN-LLM-provider change (see
`env.template`) to keep answering the same way; without one, activation silently moves it to
Roxane at $0 credit. Roxane stays listed either way, and you can switch to it after a top-up.

**Licence expiry or reinstalling.** A licence that lapses past its grace period, fails
validation, or no longer matches this host's identity re-arms the gate. Re-registering with
**the same request code** is refused: the portal already has that exact code bound to this
install (`CODE_ALREADY_CLAIMED`). What actually works:

1. After `--purge` or a move to a new host, the fresh identity prints its own new code:
   activate it like any new install. There is no limit on how many free Community installs
   one cloud account activates. Delete the old install's activation at
   `https://client.privos.io` (workspace settings → self-hosted) only to tidy up.
2. Same identity only (grace/validation failure, not `--purge`): as an admin, regenerate the
   request code (Admin → License page's "Regenerate", or `POST /api/v1/cloud.selfHosted.regenerate`
   — reachable even while the gate is armed) so the hub mints and re-registers a fresh code.
   A fresh identity's own code needs no regenerate step.
3. Activate with that code the normal way, above.

`install.sh`'s printed summary and the interactive activation wait both read the hub's local
activation-status file, which is not currently rewritten when the gate re-arms — they can keep
reporting a stale "done"/"Activated" state after a re-arm. The gate itself (the UI shown to
every signed-in user, and the REST allowlist) is the accurate signal.

**Air-gapped install.** Roxane needs internet. Activation itself still works with no direct
internet access on the PrivOS host:

1. On the gate page, choose **Offline / air-gapped** to get an **offline request token**
   (`PRVOFF1.…`-prefixed, valid 30 days). Pasting it again later (e.g. after a retry) is safe —
   it re-binds the same code to the same install rather than being rejected as already used.
2. On any machine that *does* have internet access, open
   `https://client.privos.io/self-hosted/activate`, paste the token, sign in, and activate.
3. Download the licence file from that workspace's page in the portal.
4. Back on the air-gapped host, paste the downloaded licence into the hub's gate. It applies
   immediately — no polling and no outbound connection required for this step.

A fully offline host still needs an LLM to talk to: point it at a private/LAN Anthropic-/
OpenAI-compatible endpoint using the same `PRIVOS_EGRESS_ALLOWLIST` + BYO-provider path
described under "LAN / private LLM endpoints" in `env.template`, which requires a sandbox
image with the LAN-LLM-provider change. Nothing beyond exactly that path — an explicitly
allowlisted and configured private endpoint — is promised for an air-gapped install.

## Contents

| File | Purpose |
|---|---|
| `install.sh` | Preflight, port checks, license acceptance, secret gen, RustFS init, DOCKER-USER rules, **minisign verify**, digest-pinned pull, wait + print activation request code |
| `compose.yml` | Fleet-renderer-matched stack; only the hub port public, sandbox plane on loopback; `knowledge-vector` / `local-runtime` opt-in profiles |
| `env.template` | Documented knobs; secrets generated locally by the installer |
| `rustfs-init.sh` | Bucket + scoped service account (mirrors the fleet provisioner) |
| `docker-user-rules.sh` | Firewall rules so a later `ports:` edit can't expose the sandbox plane |
| `versions.json` | Bundle version + `@sha256` image digests + file hashes (resolved at publish) |
| `publish-self-hosted-bundle.sh` | Resolve digests, sign with minisign, publish a GitHub Release |
| `SIGNING.md` | How the bundle is signed; the embedded public key |
| `LICENSE` | PrivOS Community License 1.0 |
| `tests/` | Bash unit tests (port-check, env render, signature/hash verify, license acceptance, activation gate) + CI |
| `cli/` | `privos` CLI source (sandbox and hub reads). Not part of the signed install bundle |
| `docs/cli/`, `docs/api/` | CLI configuration and the REST calls the CLI makes |

## Security

The installer verifies a **minisign** signature over `versions.json` + `compose.yml`, checks
every other bundle file against the sha256 hashes carried in the signed `versions.json`, and
pulls images by immutable `@sha256` digest. Only the hub port is published on `0.0.0.0`;
board, proxy, RustFS and the VM pool bind `127.0.0.1`. See `SIGNING.md` for the public key.
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
[fair-code](https://faircode.io) license: the source of the installer is available and the software
is free to use within the Community tier, while commercial, hosted-service, and redistribution
rights are reserved. Plain-English answers: [`LICENSE-FAQ.md`](./LICENSE-FAQ.md). It is **not an Open Source license** — like
n8n's Sustainable Use License, it limits *how* the software may be used, which the OSI definition
does not allow.

- **Free Community tier:** production use with up to **10 Active Human Users** — people who
  sign in with an account — counted across all deployments your company runs (bots,
  integrations, AI agents, and guests who never sign in do not count).
- **More than 10 users:** requires a Commercial License Key from Roxane, Inc. — activate at
  `https://client.privos.io/self-hosted/activate`.
- **Hosted/managed services (SaaS) and commercial redistribution** of PrivOS or modified versions
  require a Partner License.
- Giving an unmodified copy to someone for free, and charging for your own installation or support
  services, is allowed — each deployment is its own licensee.

Portions of PrivOS Hub are derived from Rocket.Chat 7.9.1 and remain under the MIT License
(byte-identical upstream files: [`rocketchat-upstream-files.txt`](./rocketchat-upstream-files.txt));
third-party components keep their own licenses ([`NOTICE`](./NOTICE), [`OPEN-SOURCE-NOTICES`](./OPEN-SOURCE-NOTICES)).
Trademarks: [`TRADEMARK.md`](./TRADEMARK.md). Contributions require the [CLA](./CLA.md).
Licensing inquiries: legal@privos.ai · Licensor: Roxane, Inc. (Delaware, USA).
