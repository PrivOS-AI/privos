# PrivOS Contributor License Agreement (CLA)

**Version 1.0 — Roxane, Inc.**

Thank you for your interest in contributing to PrivOS. This agreement sets
out the rights you give Roxane, Inc. ("Roxane") in the material you
contribute. It exists for one reason: PrivOS is distributed under the PrivOS
Community License, is also offered under commercial licenses, and is intended
to be released under an OSI-approved open source license in the future.
Roxane can only do that if it holds sufficient rights in every line of code
in the project, including yours.

This agreement does **not** transfer ownership. You keep the copyright in
everything you contribute and remain free to use your own contribution
however you like, including in other projects.

Read it, then sign it as described in [How to sign](#how-to-sign).

---

## 1. Definitions

**"You"** means the individual who signs this agreement or, where section 8
applies, the legal entity on whose behalf it is signed. For a legal entity,
"You" includes all entities that control, are controlled by, or are under
common control with that entity. "Control" means ownership of substantially
all the assets of an entity, or the power to direct its management and
policies by vote, contract, or otherwise, whether directly or indirectly.

**"Contribution"** means any original work of authorship, including any
modification of or addition to an existing work, that You intentionally
submit to Roxane for inclusion in, or documentation of, any project owned or
managed by Roxane. "Submit" means any form of communication sent to Roxane or
its representatives, including pull requests, patches, issues, and electronic
mailing lists, but excludes communication that You conspicuously mark in
writing as "Not a Contribution".

**"Project"** means PrivOS and any other software project owned or managed by
Roxane to which You submit a Contribution.

## 2. Copyright license

You grant Roxane a perpetual, worldwide, non-exclusive, irrevocable,
royalty-free, fully paid-up, **sublicensable and transferable** license to
reproduce, prepare derivative works of, publicly display, publicly perform,
distribute, make available, and otherwise exploit Your Contribution and such
derivative works, in source and object form, in whole or in part.

Recipients of software distributed by Roxane receive the same rights in Your
Contribution as Roxane grants them in that software, and no more.

## 3. Right to license on any terms

You expressly agree that Roxane may license and relicense Your Contribution,
and any work incorporating it, **under any license terms Roxane chooses**,
including the PrivOS Community License, commercial and proprietary licenses,
and OSI-approved open source licenses, and may do so without further notice to You and
without any obligation to account to You.

## 4. Patent license

You grant Roxane a perpetual, worldwide, non-exclusive, irrevocable (except as
stated below), royalty-free, fully paid-up, sublicensable and transferable
patent license to make, have made, use, offer to sell, sell, import, and
otherwise transfer Your Contribution, where such license applies only to those patent claims
licensable by You that are necessarily infringed by Your Contribution alone or
by combination of Your Contribution with the Project.

Recipients of software distributed by Roxane receive the same patent rights in
Your Contribution as Roxane grants them in that software, and no more.

If any entity institutes patent litigation against You or any other entity
alleging that Your Contribution, or the Project to which You contributed,
constitutes direct or contributory patent infringement, any patent licenses
granted to that entity under this agreement for that Contribution terminate as
of the date such litigation is filed.

## 5. Moral rights

You agree not to assert against Roxane or its licensees any moral rights,
rights of attribution, or rights of integrity in Your Contribution in a way
that would prevent Roxane from exercising the rights granted above. This is a
covenant not to assert those rights, not a waiver of them; in jurisdictions
where such rights cannot be waived, they remain Yours.

## 6. Your representations

You represent that:

1. Each Contribution is Your original creation, or You have the right to
   submit it under the terms of this agreement.
2. You are legally entitled to grant the above licenses. If Your employer has
   rights in intellectual property You create, You have received permission to
   make the Contribution on behalf of that employer, Your employer has waived
   such rights, or Your employer has signed this agreement as an entity under
   section 8.
3. Your Contribution does not, to the best of Your knowledge, infringe or
   misappropriate any third party's intellectual property rights, and does not
   contain any code You are not entitled to submit.
4. If Your Contribution includes or is based on material created by a third
   party, or is subject to a third-party license or other restriction
   (including related patents and trademarks), You have identified that
   material and those restrictions in Your submission, completely and
   conspicuously.
5. Your Contribution does not contain any secret or confidential information,
   any credential, key, or token, or any personal data belonging to You or
   anyone else. This does not apply to the authorship information this
   agreement requires You to provide (the name and email address in Your
   commits and sign-off), nor to attribution and copyright notices for
   third-party material identified under paragraph 4.

## 7. No warranty and no obligation

Except for the representations in section 6, Your Contribution is provided
"as is" without warranty of any kind, express or implied, to the fullest
extent permitted by applicable law.

Roxane is under no obligation to accept, merge, use, or maintain any
Contribution, and may remove or modify it at any time. Nothing in this
agreement creates an employment, partnership, agency, or joint venture
relationship, or an obligation to pay You anything.

You agree to notify Roxane if any of the representations in section 6 later
becomes inaccurate.

## 8. Contributions on behalf of an entity

If You are submitting Contributions in the course of work for a company or
other legal entity, or using that entity's resources, the entity must sign
this agreement through a person authorized to bind it. In that case "You"
means the entity, and the entity must maintain, and provide to Roxane on
request, the list of individuals authorized to submit Contributions on its
behalf.

## 9. Governing law

This agreement is governed by the laws of the State of Delaware, United
States of America, without regard to its conflict-of-laws rules. It does not
deprive You of the protection of any mandatory provision of the law of Your
country of residence.

---

## How to sign

**Every pull request must carry both of the following.**

**1. Sign-off on every commit.** Add a `Signed-off-by` line using your real
name and the email address associated with your commits:

```
git commit -s -m "your message"
```

which appends:

```
Signed-off-by: Jane Doe <jane@example.com>
```

**2. Acceptance of this CLA.** In the description of your first pull request,
include the line:

```
I have read the PrivOS CLA (CLA.md) and I accept it. My contributions are
made under its terms.
```

For contributions made on behalf of a legal entity (section 8), a signed copy
of this agreement is required in addition. Email legal@privos.ai and we will
send you the entity form.

If you are unsure whether section 8 applies to you, ask before you open the
pull request rather than after.

Contributions submitted without both steps cannot be merged, regardless of
their quality. This is not a judgment about your work; it is that we cannot
lawfully relicense code whose rights are unclear, and unclear code today
becomes an unremovable problem the day the project opens its source.
