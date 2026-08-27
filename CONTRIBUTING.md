# Contributing to PrivOS

We are not accepting general code contributions yet.

Reviewing code, keeping quality high, and keeping the product coherent are the
constraints on this project right now, not the writing of code. Taking in a
large volume of contributions we cannot review properly would slow PrivOS down
rather than speed it up. This will change as the project matures and more of
the source is opened; until then, the policy below applies.

## What is welcome

- **Bug reports.** Open an issue with your OS and version, the exact install
  command you ran, the relevant output, and what you expected instead.
- **Feature requests and product feedback.** Use discussions. Tell us what you
  are trying to do, not only the feature you have in mind.
- **Design and architecture ideas.** Talk to us before writing any code.
- **Security vulnerabilities.** Do not open a public issue. Email
  security@privos.ai. Release signatures and how to verify them are documented
  in the repository.
- **Licensing and attribution questions.** legal@privos.ai

## Pull requests

We will consider small, easily verified pull requests that fix a real problem
in the installer — a broken path, an unhandled error, a wrong check.

- Roughly a dozen changed lines is the upper bound of "easily verified".
- `shellcheck` must pass.
- The test suite must pass.
- For anything larger, open a discussion first, so that neither of us spends
  time on a change we cannot merge.

## Licensing of contributions

PrivOS is distributed under the PrivOS Community License (see `LICENSE`), is
also offered under commercial licenses, and is intended to be released under an
OSI-approved open source license in the future. We can only do that if we hold
clear rights in every line of code in the project.

**Every contribution therefore requires the PrivOS Contributor License
Agreement in [`CLA.md`](CLA.md).** It does not transfer ownership — you keep
your copyright — but it grants us a broad, sublicensable license and the right
to relicense the project, including under commercial and open source terms.

Two things are required on every pull request:

1. **Sign off every commit** with your real name and the email on your commits:

   ```
   git commit -s -m "your message"
   ```

2. **Accept the CLA** in the description of your first pull request:

   ```
   I have read the PrivOS CLA (CLA.md) and I accept it. My contributions are
   made under its terms.
   ```

If you are contributing in the course of your work for a company, or using
company equipment or time, your employer must sign the entity form as well —
email legal@privos.ai and we will send it to you.

We cannot merge contributions without both steps, however good the patch is.
Code whose rights are unclear is not a problem that can be fixed later; it is a
permanent obstacle to opening the source.

Contributions of third-party code, or code produced with an AI assistant from
material you do not have rights to, cannot be accepted. If any part of your
change comes from somewhere else, say so in the pull request and name the
source and its license.

## Reporting a licensing or attribution problem

If you believe PrivOS ships a component without correct attribution, or in
breach of a third-party license, we want to know and we will fix it. Email
legal@privos.ai with the component, the file, and the license concerned. This
is not treated as an adversarial report.
