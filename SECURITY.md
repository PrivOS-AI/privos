# Security policy

PrivOS is a self-hosted platform that runs AI agents against your company's messages, files and lists. We treat security reports as the highest-priority work in the project.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for a security problem.

- Email **security@privos.ai**. You will get a human acknowledgement within **2 business days**.
- Include: affected component (hub, sandbox, installer, an MCP app), version (`versions.json` `stackVersion` or the image tag), steps to reproduce, impact, and a proof of concept if you have one.
- If you need to encrypt the report, ask for our PGP key in a first plain email.

We do not run a paid bounty programme today. We credit reporters in the release notes of the fix unless you ask us not to.

## What happens next

| Severity (CVSS v3.1) | Fix target | Communication |
|---|---|---|
| Critical (9.0+) | Patched release within **72 hours** of confirmation | Security advisory + email to registered self-hosted operators |
| High (7.0–8.9) | Patched release within **7 days** | Security advisory |
| Medium / Low | Next scheduled release, at most **30 days** | Release notes |

Coordinated disclosure: we ask for **90 days** from the report before public disclosure, or sooner once a fix is released, whichever comes first.

## Supported versions

Self-hosted installs are versioned by the `stackVersion` published in `versions.json` with each release.

- The **latest release** receives all security fixes.
- The **previous minor release** receives fixes for Critical and High issues for **90 days** after the next minor ships.
- Anything older is unsupported; upgrade with the installer.

PrivOS Cloud always runs the latest release, so a fix reaches Cloud workspaces before or at the same time as the self-hosted release.

## Upstream components

PrivOS Hub is derived from Rocket.Chat (MIT; see `rocketchat-upstream-files.txt`). We track Rocket.Chat security advisories and backport relevant fixes to the files we still share with upstream on the same schedule as our own issues. Vulnerabilities in the bundled services (MongoDB, Redis, RustFS, LiteLLM) are handled by pinning the fixed image digest in the next release.

## Scope

In scope: the PrivOS Hub, sandbox, installer and deployment configuration, the agent SDK, and MCP apps published by PrivOS-AI.
Out of scope: third-party MCP apps and integrations you install yourself, your own model provider, and issues that require physical access to the host.
