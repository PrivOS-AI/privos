# Contributing to PrivOS

At this time, we are **not seeking outside code contributions**. We *are* seeking your
issues and feedback.

AI has made writing code easy. The hard part today is not writing the code, but reviewing
it, keeping quality high, and keeping the product coherent. External code contributions
"donate" the easy part of the job while creating more of the hard part. In addition, the
PrivOS is fair-code and its product source is not yet published (see "Roadmap: open source" in the README), so
only the installer in this repository can be changed by a pull request at all.

## What we welcome

| You have… | Please… |
|---|---|
| A bug (installer fails, port check wrong, upgrade broke, docs wrong) | [Open an issue](https://github.com/PrivOS-AI/privos/issues/new/choose) using the bug template — include your OS/arch, Docker version, the exact command, and the installer output (it never prints secrets). |
| Feedback, a feature request, a "what I'd need to adopt this" | [Open a discussion](https://github.com/PrivOS-AI/privos/discussions). |
| A big idea | A discussion **first**, before anyone writes code. |
| A security vulnerability | Email `security@privos.ai`. Do **not** open a public issue. |
| A licensing question | Email `legal@privos.ai`. |

## Pull requests

We are happy to accept **small, trivially-verified PRs** to the installer that fix a real
problem. Please refrain from low-value PRs (e.g. typo fixes) or PRs larger than a dozen or
so lines; such PRs will be closed with a reference to this guideline.

For an accepted PR: `shellcheck` must be clean and `bash tests/run-tests.sh` must pass
(CI runs both). By submitting a PR you agree that your contribution is licensed under the
PrivOS Community License 1.0 and that Roxane INC may relicense it when PrivOS moves to an
open source license.

This policy will change as the project matures and the source is opened. Until then, thank
you for your understanding.
