# PrivOS — the AI-native operating system for enterprise work

Community Edition is free and self-hosted for up to 10 users (signed-in users across your company), commercial rights reserved.
**The installer is source-available today; we plan to open the full PrivOS source in the near future (no date yet).** See [License](#license).

> **Beta — install at your own risk.** PrivOS Community Edition is in a testing phase.
> The installer, images and upgrade path are still changing, and an install or upgrade
> can fail or leave a half-configured host. Before you run it: use a fresh VM or a host
> you can rebuild, keep backups of anything you care about, and expect breaking changes
> between releases. No warranty and no support commitment apply during the beta; report
> problems as GitHub issues, and security issues to security@privos.ai. By running the
> installer you accept these risks.

## What is PrivOS?

**PrivOS is the all-in-one, AI-native operating system for enterprise work: Chat + Docs +
Tasks + tailored Apps, with AI agents that act.**

Most teams spread their work across a chat tool, a document store, a task tracker, a pile of
business apps, and an AI assistant that can only talk. PrivOS puts all of it in one
workspace that runs on your own servers. Your messages, files, and agent work stay on
infrastructure you control.

- **Chat.** Channels, direct messages, and rooms where people and AI agents work side by
  side. Agents are members of the room. They answer in context and pick up work from the
  conversation.
- **Docs.** Files shared in a room are parsed so agents can read and search them. Each room
  can keep its files in its own S3-compatible object storage (RustFS in this bundle). Firm
  Knowledge holds the company's governed knowledge, which people use in rooms and agents
  read through an OAuth-protected MCP interface.
- **Tasks.** A Kanban board tracks every task with its full conversation history.
  Checkpoints let you fork or rewind a task. Butler runs scheduled tasks on its own.
- **Tailored Apps.** Apps open as tabs inside a room and work on the room's lists, files,
  and messages. Install them from the Marketplace, or build your own as an MCP server with
  the PrivOS app SDK. Every app call is checked against the scopes an admin granted.
- **Agents that act.** PrivOS agents don't stop at answering. They run tools, edit code
  with Git, update lists, and finish tasks, each one inside an isolated VM. Use the
  agent backend you prefer: Claude Code CLI, Codex CLI, the Skawld SDK, or any Anthropic- or
  OpenAI-compatible model endpoint. A headless REST + SSE API and the `privos` CLI let
  your own systems drive them.

Out of the box, agents use **Roxane**, the built-in model provider served by the PrivOS
gateway. You can add your own model endpoint instead, including a private one on your LAN
(see [Activation](#activation)).

Under the hood, a PrivOS install has two parts. **PrivOS Hub** is the workspace people use:
chat, docs, and apps. **PrivOS Sandbox** is where agents run their tasks.

PrivOS runs in two ways:

- **Self-hosted Community Edition** (this repository) is a single-host Docker Compose install
  that is free for up to 10 signed-in users.
- **PrivOS Cloud** is a managed workspace at [client.privos.io](https://client.privos.io).

## This repository

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

`privos` is a separate client for a running sandbox board and hub (projects,
tasks, rooms, messages, lists, and items). It does not install or upgrade the stack. Install it
with npm (`npm install -g @privos_ai/privos` or `npx @privos_ai/privos`) — the
command is `privos`. Writes are a dry run unless you pass `--confirm`. See
[docs/cli/README.md](docs/cli/README.md). API notes are in
[docs/api/](docs/api/).

## ⚠️ WARNING: Early access

PrivOS is in a state of heavy development. The self-hosted path in this repository is
new and still has rough edges — we know, and we're working on it. For now, consider this
an **early access** release: expect breaking changes between versions, read the release
notes before `--upgrade`, and keep backups of `/opt/privos` (the installer never deletes
data unless you pass `--uninstall --purge`).

## Intended usage (once released)

**Linux** (as root):

```bash
curl -fsSL https://github.com/PrivOS-AI/privos/releases/latest/download/install.sh | sudo bash
# overrides: --hub-port N  --vm-port-range A-B  --dir /opt/privos  --yes (implies license acceptance)
#            --with-knowledge-vector  --without-app-cluster  --upgrade  --uninstall [--purge]
```

**macOS** (as your normal user, no `sudo`; Docker Desktop must be installed):

```bash
curl -fsSL https://github.com/PrivOS-AI/privos/releases/latest/download/install.sh | bash
```

**Windows** (x64 or ARM64; PowerShell; Docker Desktop with the WSL 2 backend must be installed):

```powershell
irm https://github.com/PrivOS-AI/privos/releases/latest/download/install.ps1 | iex
# flags with the file form: powershell -ExecutionPolicy Bypass -File install.ps1 -HubPort 3001 -Upgrade ...
# with `irm | iex`, set overrides as $env:PRIVOS_* variables first (same names as install.sh)
```

| Platform | CPU | Status | Container runtime | Images | Data lives in |
|---|---|---|---|---|---|
| Linux (Ubuntu, Debian, RHEL family) | x86_64 | Beta | Docker Engine ≥ 24 with compose v2 (or `--install-docker`) | linux/amd64 | `/opt/privos/data` |
| Linux (Ubuntu, Debian, RHEL family) | arm64 (e.g. Ampere, Graviton) | **Alpha** | Docker Engine ≥ 24 with compose v2 (or `--install-docker`) | linux/arm64, native | `/opt/privos/data` |
| macOS 13+ | Apple Silicon and Intel | **Alpha** | Docker Desktop ≥ 4.30, memory ≥ 6 GB (8 GB recommended) | linux/arm64 natively on Apple Silicon (no Rosetta), linux/amd64 on Intel | Docker named volumes `privos-*` inside Docker Desktop; install dir `~/.privos` |
| Windows 10 22H2 / 11 (x64), Windows 11 (ARM64) | x64 and ARM64 (e.g. Snapdragon) | **Alpha** | Docker Desktop ≥ 4.30, WSL 2 backend (Hyper-V backend not supported), memory ≥ 6 GB (8 GB recommended) | linux/amd64 on x64, linux/arm64 natively on ARM64 | Docker named volumes `privos-*`; install dir `%LOCALAPPDATA%\PrivOS` |

> **Alpha platforms.** Linux on x86_64 is the platform the hosted PrivOS fleet runs and the one we
> test every release on. Linux on arm64, macOS and Windows are **alpha versions**: they install the
> same release, but they have had far less testing, so expect bugs and rough edges, and do not use them
> for data you cannot afford to lose. Please report problems you hit on them.

Every PrivOS image is published for both linux/amd64 and linux/arm64 under one tag; the installer
picks the right one automatically and refuses a release that lacks the architecture it needs.

On macOS and Windows the installer adds `compose.desktop.yml` (signed like `compose.yml`): data
moves into named volumes, and a small `privos-netguard` container applies the same loopback and
agent-egress firewall rules inside the Docker Desktop VM that `docker-user-rules.sh` applies on a
Linux host. The hub is published on all interfaces (`0.0.0.0:3000`) on every platform; Windows asks
once to allow Docker Desktop through the firewall. Enable Docker Desktop's "Start Docker Desktop when
you sign in" so PrivOS comes back after a reboot. macOS ships with the first release whose images all
carry `linux/arm64`; until then the installer stops with a clear message on macOS and on any arm64
machine.

`--uninstall --purge` (`-Uninstall -Purge` on Windows) deletes everything the install created: the
stack's containers and data (`/opt/privos`, or the `privos-*` volumes on Desktop), agent containers,
the marketplace apps the App Cluster runs (containers and volumes labelled `mcp-app=true`, network
`mcp-apps-network`), both networks, the firewall rules and the install directory. Downloaded images
are kept; remove them with `docker image prune -a` if you want the disk space back.

Host prerequisites on Linux: `curl`, `jq`, `minisign`, `openssl` on PATH (Debian/Ubuntu:
`apt-get install -y jq minisign`). On macOS the installer uses Homebrew when present and otherwise
downloads pinned, checksum-verified `jq` and `minisign` into `~/.privos/bin`; on Windows it downloads
a pinned, checksum-verified `minisign.exe`. Every installer stops before touching anything if a
prerequisite is missing.

Docker Desktop requires a paid subscription for organisations above 250 employees or USD 10 million
annual revenue (Docker's terms); Linux with Docker Engine has no such licence.

**Backups.** Linux: stop the stack and archive `/opt/privos`. macOS / Windows: stop the stack and
archive each volume, for example
`docker run --rm -v privos-mongo:/v -v "$PWD":/b alpine tar -czf /b/privos-mongo.tgz -C /v .`
(repeat for every `privos-*` volume listed by `docker volume ls`), plus the install directory.

## Activation

Activation is **required** on every Community Edition install: until it completes, nothing
is usable — the UI shows a gate to every user, and the REST API refuses everything except a
small allowlist (login, `info`, public settings, and the activation endpoints themselves).
This is a **free lead-registration gate, not DRM**: the installer in this repository is public and
the check runs on your own host, so an operator could patch it out, and we're not pretending otherwise — it exists so we know who is running
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
| `install.ps1` | Windows port of `install.sh` (PowerShell 5.1+, Docker Desktop) — same stages, flags and `.env` |
| `compose.yml` | Fleet-renderer-matched stack; only the hub port public, sandbox plane on loopback; `knowledge-vector` / `local-runtime` opt-in profiles |
| `compose.desktop.yml` | Docker Desktop overlay (macOS, Windows): named volumes, `privos-init` ownership step, `privos-netguard` firewall helper |
| `netguard/Dockerfile` | The `privos-netguard` image: `docker-user-rules.sh --loop` inside the Docker Desktop VM |
| `env.template` | Documented knobs; secrets generated locally by the installer |
| `rustfs-init.sh` | Bucket + scoped service account (mirrors the fleet provisioner) |
| `docker-user-rules.sh` | Firewall rules so a later `ports:` edit can't expose the sandbox plane; `--loop` re-applies them on Docker Desktop |
| `versions.json` | Bundle version + `@sha256` image digests + file hashes (resolved at publish) |
| `publish-self-hosted-bundle.sh` | Resolve digests, sign with minisign, publish a GitHub Release |
| `SIGNING.md` | How the bundle is signed; the embedded public key |
| `LICENSE` | PrivOS Community License 1.0 |
| `tests/` | Bash unit tests (port-check, env render, signature/hash verify, license acceptance, activation gate) + CI |
| `cli/` | `privos` npm CLI (`@privos_ai/privos`), MIT licensed (`cli/LICENSE`). Not part of the signed install bundle |
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

**The installer is source-available today; we plan to open the full PrivOS source in the near future
(no date yet).** PrivOS is distributed under the [PrivOS Community License 1.0](./LICENSE) — the
product ships as signed container images, and commercial use beyond the Community tier is reserved.
We will announce the source opening in this repository when we do. Until then the Community License applies to every release,
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
source-available license: the source of the installer is available and the software
is free to use within the Community tier, while commercial, hosted-service, and redistribution
rights are reserved. Plain-English answers: [`LICENSE-FAQ.md`](./LICENSE-FAQ.md). It is **not an Open Source license** — like
n8n's Sustainable Use License, it limits *how* the software may be used, which the OSI definition
does not allow.

**Exception:** the operator CLI in [`cli/`](./cli) (`@privos_ai/privos` on npm) is MIT licensed —
see [`cli/LICENSE`](./cli/LICENSE).

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
