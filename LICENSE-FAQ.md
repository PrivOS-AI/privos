# PrivOS licensing — plain English FAQ

This FAQ explains the [PrivOS Community License](LICENSE) in ordinary language.
It is a summary for orientation. **The license text is what counts** — where
this page and the license disagree, the license wins. Nothing here is legal
advice.

Still unsure after reading this? Email legal@privos.ai and describe what you
want to do.

---

## The short version

- **Free for up to 10 people**, in total, per company, in any environment.
- **More than 10 people** → a commercial key for every deployment you run.
  Your limit becomes the greater of ten and what your keys cover.
- **Running it for other people, or selling it under your own brand** →
  Partner License.
- **Your data stays yours.** The license governs the software, not your data.

---

## Using it for free

### Is PrivOS open source?

No, and we do not claim it is. The installer and the deployment configuration
in this repository are source-available: you can read them, run them, and
change them. The Hub and sandbox components ship as signed container images and
their source is not published yet. The license also restricts commercial
hosting, offering the software under your own brand, and redistribution. None
of that meets the Open Source Initiative's definition, so we do not use the
term. We intend to release PrivOS under an OSI-approved license eventually. We
have not committed to a date.

### What does "10 Active Human Users" count?

**People, not accounts.** Any natural person who used PrivOS in the last 30
days counts once, however many deployments they touch.

- Someone who has not used PrivOS in the last 30 days: not counted.
- A bot, integration, or AI agent: never counted as a user in itself.
- A person who *directs* an agent through PrivOS or an interface to it —
  counted, as one person.
- One shared login used by four people: counts as four.
- Guests, anonymous access, and people reaching PrivOS through a widget or a
  front end you built: counted — they are accessing a deployment.
- Your own people, and anyone doing work for you (contractors, agencies,
  outsourced teams), whose content or requests reach PrivOS: counted, whichever
  system they send them through.
- Someone outside your company who emails you and whose message you relay into
  PrivOS: not counted. They never access the deployment and they are not
  working for you.
- Authors of documents you index — your own archives, a wiki, third-party
  material: not counted for authorship alone. Indexing your company's back
  catalogue does not turn everyone who ever wrote a document into a user.

### Ten per server, or ten in total?

Ten in total, across every PrivOS deployment your company runs — and "your
company" includes your parent, your subsidiaries, and anything else under
common control. Three servers with eight people each is 24 people. Once you go
over ten, *every* one of those deployments needs a key, not just the big one.

### Does a test or development instance count?

Yes. The limit covers all use, including non-production. If you need a larger
environment to evaluate PrivOS properly, ask us for a trial key — we consider
every request.

### We are a 200-person company but only 6 people will use PrivOS. Free?

Yes. The count is people who use PrivOS, not headcount.

### Can I use the free tier commercially, inside my business?

Yes. Running PrivOS to do your company's work is fine within the limit,
whatever your company does and however much money it makes. What the license
restricts is making money *from PrivOS itself* — reselling it, running it for
other people, or putting your brand on it.

### Do our customers or external guests count?

Yes, they count, whether or not you give them accounts. And there is a second
question behind that one: if what you are doing is providing PrivOS to them,
Limitation 3 requires a Partner License regardless of how few of them there
are. Giving three partner-company colleagues an account in your workspace is
collaboration. Putting a PrivOS-powered chat in front of your customers is a
service. If you are near that line, ask us.

### Non-profit, university, school, hobby project?

Same rules. There is no separate tier and no discount encoded in the license. If
the limit is a real obstacle for your organization, write to us.

---

## Paying for it

### When exactly do I need a Commercial License Key?

The moment the total across your company exceeds ten Active Human Users. A key
states the number of users it covers, and your limit is the greater of ten and
what your keys cover — so a key is not an unlimited pass, and a small key never
drops you below the free ten.
https://client.privos.io/self-hosted/activate

### What happens if a key expires, or the server is offline?

The license does not promise any particular behavior, on purpose — it depends
on the version you are running, and we do not want to be locked into today's
implementation. The documentation for your version describes what that version
does. If you run air-gapped or behind strict egress rules, tell us before you
buy — ask for a key issued for offline use and we will confirm whether we can
do that for your setup.

Restricting network access is not circumvention. What Limitation 6 catches is
doing it *in order to* run over the limit, without a key you need, or past a
key's expiry.

### Does PrivOS phone home?

License activation and validation communicate with our systems and transmit the
deployment identifier, the key, version information, and the number of active
users. The license commits that we will not design the software to send the
content of your messages, files, or data to us or to anyone else, and that
commitment is expressly carved out of the liability disclaimer. It does not
cover transmissions you set up yourself: if you connect an integration, an
offsite backup, or an external model provider, that is your configuration and
your call.

### Can I modify PrivOS?

For your own use and your company's own use, yes. In practice that means the
installer and deployment configuration, since the Hub and sandbox ship as
images. You may not ship a modified version to anyone outside your company
without a Partner License.

### Can I give PrivOS to someone else?

Yes — an unmodified copy, free of charge, with the license and notice files
passed on, and not to someone you know will run it over their free limit
without a key. You may charge them for your work (installation, configuration,
integration, support, training). You may not charge them for the software.

### Can I publish a fork?

Not without a Partner License. Limitation 5 lets you modify PrivOS for
yourself and your company, but not distribute or deploy a modified version to
anyone else. Sending us a pull request is expressly not a breach of that.

### I run an IT consultancy. Where is the line?

The license draws it by who has **operational control** of the deployment and
who is licensed for it:

- Your client controls the deployment — decides whether and where it runs,
  contracts for the infrastructure in its own name, and can take administration
  back at any time — **and** the client holds its own key or is within its own
  free tier. That second condition matters: the carve-out does not cover
  putting an unlicensed client into production. You install, integrate,
  administer, monitor and support it, set up its users, and invoice your hours.
  No Partner License needed. Administering it for them does not make it yours.
- You control or supply the deployment, or give clients logins on infrastructure
  you run: hosted service, Partner License.
- You put PrivOS behind your own product, API, or brand and sell that: Partner
  License, whether or not you host it.

### What is a Partner License?

A separate written agreement with us for hosting, own-brand offerings,
reselling, or distributing modified versions. It is not something you accept by
clicking; talk to legal@privos.ai.

---

## Third-party software and data

### PrivOS ships MongoDB, Redis, MinIO. What licenses are those under?

Their own, listed in [OPEN-SOURCE-NOTICES](OPEN-SOURCE-NOTICES) together with
where to get their source. We do not license them to you and cannot grant you
rights in them.

Read the "network and service-side obligations" section of that file if you
plan to make your deployment available to other people. Some of those
components (AGPL, SSPL) place obligations on operators. A PrivOS Partner
License covers PrivOS; it cannot waive obligations that belong to MongoDB,
MinIO, or Redis.

### PrivOS Hub is based on Rocket.Chat. Does that make it MIT?

Only in part, and the boundary is written down. The unmodified upstream
Rocket.Chat files we ship are listed file by file in
`rocketchat-upstream-files.txt`; those are MIT, with the required copyright
notice in OPEN-SOURCE-NOTICES. Our modifications to them, and everything else
we wrote, are under the PrivOS Community License. We ship no Rocket.Chat
Enterprise Edition code.

### Who owns the data in my deployment?

You do. The license has a section headed "Your data" saying we obtain no
ownership of and no license to anything you process with the software.

---

## Rules and edge cases

### Can I remove the license key check?

No — Limitation 6. It covers tampering with the check, with the user count, and
with the validation traffic, where the point is to run without a key you need.

### We spin up a new server. Do we need its key before it boots?

You have 30 days from creating a new deployment — or from first going over ten
users, whichever is later — to get its key. Staging and short-lived
environments do not put you in breach on day one, but their users do count
toward your total. Tearing a deployment down and rebuilding it does not restart
the 30 days.

### What if we go over the limit by accident?

Going over the limit does not switch your license off. The excess is
unlicensed; the rest of your use carries on. Fix it within 30 days — the clock
starts when we tell you or when someone responsible for your use of PrivOS
notices, whichever comes first — and nothing terminates. Fix it later than
that and your license still comes back from the day you fix it, unless the
breach was deliberate.

What fixing it does not do is make the over-limit period free: we can charge
for it at our published prices for that period. And a further material breach
after that, left uncorrected past its 30 days, ends the license permanently.

### Will you audit us?

There is no audit right in this license. If we have a concrete reason to think
your use is over the limit, we can ask you in writing to confirm your user
count, and you have 30 days to answer. No access to your systems, no access to
your data. Note that not answering is itself a breach, and that Limitation 8
requires you to keep records good enough to answer once you are past ten users
or past half your maximum, whichever comes first — the numbers the product
gives you, plus a sensible estimate for anything it cannot count.

### We are owned by a group. Do our sister companies count?

The limit aggregates across entities under common control. In practice, count
the deployments you and your affiliates actually operate. If your group
structure makes that genuinely impossible to determine, talk to us before
assuming the worst reading — we would rather agree a sensible boundary in
writing than have you guess.

### What if we get acquired?

Your license transfers to the buyer on written notice to us. If the combined
business then exceeds the buyer's own user maximum, they have 30 days to buy up
to it. There is an Assignment section in the license for exactly this.

### Can I use the name "PrivOS" for my thing?

For describing compatibility ("works with PrivOS"), yes. For your own product,
service, company, or domain name, ask first — and note that an own-brand
offering needs a Partner License as well. See [TRADEMARK.md](TRADEMARK.md).

### Can you change the license later?

We can publish future *versions* under different terms — and if we go
OSI-approved, we will. What we cannot do is retroactively change the terms of a
version you already have. That is in the license under "Versions of this
license".
