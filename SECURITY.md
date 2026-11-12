# Security policy

PrivOS is a self-hosted platform that runs AI agents against your company's messages, files and lists. We treat security reports as the highest-priority work in the project.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for a security problem.

- Email **security@privos.ai**. You will get a human acknowledgement within **2 business days**.
- Include: affected component (hub, sandbox, installer, an MCP app), version (`versions.json` `stackVersion` or the image tag), steps to reproduce, impact, and a proof of concept if you have one.

We do not run a paid bounty programme today. We credit reporters in the release notes of the fix unless you ask us not to.

## What happens next

We roll PrivOS Cloud and the workspaces we manage ourselves. A self-hosted install needs a published
bundle and your own upgrade, so the two have separate targets.

| Severity (CVSS v3.1) | PrivOS Cloud and managed workspaces | Self-hosted bundle | Communication |
|---|---|---|---|
| Critical (9.0+) | Fixed release rolled out within **72 hours** of confirmation | Published within **7 days** of the fix | Security advisory + email to registered self-hosted operators |
| High (7.0–8.9) | Within **7 days** | Within **14 days** | Security advisory |
| Medium / Low | Next scheduled release, at most **30 days** | Next bundle, at most **30 days** | Release notes |

Coordinated disclosure: we ask for **90 days** from the report before public disclosure, or sooner once a fix is released, whichever comes first.

## Supported versions

Self-hosted installs are identified by the `stackVersion` published in `versions.json` with each release,
for example `v7.15.42-tenant.445`.

- Only the **latest published release** is supported and receives security fixes.
- Our releases are **forward-only**: a fix ships in a new release rather than as a patch to a superseded
  one, and database migrations only move forward. An affected install is remediated by upgrading with the
  installer, not by a backport to an older build.
- Every advisory names the release that carries the fix and the releases that are affected.

PrivOS Cloud always runs the latest release, so a fix reaches Cloud workspaces before or at the same time as
the self-hosted bundle.

## Upstream components

PrivOS Hub is derived from Rocket.Chat (MIT; see `rocketchat-upstream-files.txt`). We track Rocket.Chat security advisories and backport relevant fixes to the files we still share with upstream on the same schedule as our own issues. Vulnerabilities in the bundled services (MongoDB, Redis, RustFS, LiteLLM) are handled by pinning the fixed image digest in the next release.

## Scope

In scope: the PrivOS Hub, sandbox, installer and deployment configuration, the supported agent SDK (`@privos_ai/privos-agent-sdk`), and MCP apps published by PrivOS-AI. Archived repositories, such as the experimental `agentic-sdk`, are not supported.
Out of scope: third-party MCP apps and integrations you install yourself, your own model provider, and issues that require physical access to the host.
