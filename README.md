# Caregiver Check-In

**A voice AI system that phones an aging parent daily, confirms their medications, and texts the family only when something needs attention. Ran in daily production for a real household through September 2026.**

The parent needs nothing but a phone. No app, no device, no wearable.

[**Demo video (90 sec)**](#) <!-- TODO: record and link -->

### Why this exists

Alert fatigue kills care products. A system that reports everything trains families to stop reading, and then the alert that matters gets ignored. So a clean check-in sends no notification at all. Silence is the product: a caregiver who hears nothing should be able to conclude nothing is wrong.

That single property is what makes every bug in here worse than it looks. A suppressed alert, a false "doing okay," or a call that silently never happens all read to the user as "everything is fine."

### What's in this repo

| | |
|---|---|
| **Production** | Deployed on Vercel and run daily for one household — the developer's own parent. Twilio toll-free verification approved, SMS delivery working. |
| **Safety** | Three independent concern-detection layers: LLM extraction, a deterministic keyword backstop, and structural checks that do not ask the model at all. The model answers "what did they say"; application code decides what to do about it. |
| **Eval suite** | 19 scored transcript cases covering falls, chest pain, prompt injection, medication refusal, watch-item suppression, and the dangerous false-positive direction. 100% concern recall, 0% false alarm rate, 100% medication accuracy. Plus 15 simulated conversations scored against the live system prompt. |
| **Isolation** | 33 adversarial RLS checks, 10 prompt-refusal checks, 41 queue-integrity assertions, 323 unit tests. |
| **Consent** | California all-party consent gating on the first call. Separate SMS opt-in per family contact, with carrier opt-out (STOP) honored. |
| **Reliability** | Every duplicate-execution risk is database-enforced: `unique (parent_id, due_at)` on the slot queue, partial-index uniqueness on active calls, optimistic-concurrency claims on retries. 37 incremental migrations. |

### Built with

Next.js 16, Supabase (Postgres + RLS), Vapi (voice), Twilio (SMS), SendGrid (email), Anthropic Claude (extraction), Vercel.

---

> **Working on this codebase?** Read [HANDOVER.md](HANDOVER.md) first. It documents the
> invariants that have broken repeatedly (the consent gate, alert dedupe, calling hours),
> how to verify changes by driving the running app rather than reading it, and the nine
> tests that could not fail. It is loaded automatically via CLAUDE.md.


## How it works

```
  setup (caregiver)                    every 5 min
        │                                   │
        ▼                                   ▼
  parent · medications · appointments   scheduler ──► what's due now?
  family contacts · escalation rules         │        (timezone-aware, DST-safe)
                                             ▼
                                        outbound call (Vapi) ──► parent
                                             │
                                             ▼
                                        transcript
                                             │
                    ┌────────────────────────┼────────────────────────┐
                    ▼                        ▼                        ▼
            Claude extraction        keyword backstop        structural checks
            meds/concerns/mood       (LLM-independent)       (did they speak at all?)
                    └────────────────────────┼────────────────────────┘
                                             ▼
                                      change detection
                              (vs. this parent's own baseline)
                                             │
                          ┌──────────────────┴──────────────────┐
                          ▼                                     ▼
                   nothing changed                        something changed
                   → no notification                      → SMS + email, de-duplicated
                                                          → surfaced on dashboard
```

1. **Setup** (`/setup`) — caregiver signs in via Supabase magic link and enters their
   parent's details, medications (with times, optional date ranges for short courses, and
   an optional "how to recognize it" description), appointments, and who to notify.
   Saved as a single Postgres transaction.
2. **Scheduler** (`/api/cron/tick`, pinged externally every 5 minutes) — finds what's due
   in the parent's own timezone and places the call. Appointment-only days are covered
   too, not just medication times.
3. **The call** — Vapi assistant ("Rosie") confirms medications by name, follows up when
   one isn't confirmed rather than just acknowledging it, mentions appointments, and asks
   what the family should know.
4. **Understanding** (`/api/vapi/webhook`) — Claude extracts structured facts; a
   deterministic keyword scan and structural checks run independently so a model failure
   can't silently drop a real emergency.
5. **Deciding** — application code, not the model, decides what happens. Only genuine
   changes against that parent's recent baseline are escalated.
6. **Dashboard** (`/dashboard`) — leads with "is Mom okay, and does anything need me?",
   then what changed, then call history with transcripts and alert delivery status.

---

## Safety architecture

Concern detection is deliberately **not** a single LLM call. Three independent layers,
because the failure this product exists to prevent is a family never hearing that
something was wrong:

| Layer | Catches | Independent of |
|---|---|---|
| Claude extraction | Nuance a keyword list can't — *"I just feel off, not myself"* | — |
| Keyword scan (`lib/safety.ts`) | Emergency words if the model fails, errors, or under-classifies | The model |
| Structural checks | Parent never actually spoke; empty transcripts; no-answer | The model *and* the transcript's content |

The model answers **"what did they say?"**. Application code answers **"what do we do
about it?"** — that separation is deliberate, so behaviour can be reasoned about and
tested without re-running an LLM.

### Measured, not asserted

"We use Claude" isn't a safety argument. `evals/` scores the pipeline against transcripts
covering the cases where being wrong actually matters — deliberately split between *must
catch* (fall, chest pain, a concern mentioned after saying they're fine, refusal,
uncertainty) and *must not over-report* (a chronic complaint the person calls routine, or
a watch item the family already told us about).

```bash
npm run eval     # spends real Anthropic tokens; run on prompt/model changes
```

```
Passed:              19/19
Concern recall:      100%   ← missing these is the dangerous direction
False alarm rate:      0%   ← this is what burns caregivers out
Medication accuracy: 100%
Unknown-mood rate:     0%   ← high means it's measuring parse failures, not judgement
```

The runner applies the same deterministic backstops as production, so it measures the
system that ships rather than the model in isolation. It has already earned its keep: its
first run found that a call the parent hangs up on immediately produced no concern about
half the time, which is now determined structurally instead of being left to the model.

### Tenant isolation is tested adversarially

The most sensitive row in this system is a transcript of an elderly person's
conversation, and the boundary protecting it is RLS plus a hand-maintained "derive
ownership from the session, never the request body" convention — both invisible to the
type checker and to every other test here.

```bash
npm run security   # creates two throwaway caregivers, attacks one from the other, cleans up
```

28 checks, phrased as attacks: caregiver B attempting to read, alter, or delete A's
parent, medications, contacts, watch items, calls, messages and transcripts, plus the
privilege-escalation path through the setup RPC, plus the same attempted anonymously, plus
household deletion driven through the real transaction it uses in production.

Every child table has a matching control read as its owner. That is not decoration: the
appointments check once passed identically with RLS switched off entirely, because the
fixture seeded no appointments, and the "deleting one household doesn't touch another"
check once compared 0 to 0 because the second caregiver had no household. A check that
cannot fail is worse than no check, because it is counted.

This is not theoretical: a `SECURITY DEFINER` RPC taking `caregiver_id` as a parameter
was briefly callable with the public anon key, which would have let anyone rewrite
another household's parent phone number and redirect their check-in calls. Nothing in CI
could have caught that. This does.

---

## Reliability

Every duplicate-execution risk is **database-enforced**, not just guarded in application
logic:

| Risk | Guard |
|---|---|
| Two cron ticks dialing the same slot | `unique (parent_id, scheduled_for)` |
| Two calls active for one parent at once | `calls_parent_active_unique` partial index |
| Vapi redelivering an end-of-call webhook | Atomic conditional claim on the call's current status |
| A retry racing another tick | Optimistic-concurrency claim on `(status, retry_count)` |
| Telling a family the same thing twice | Alert fingerprints over structured facts — 4h for safety alerts, 20h for routine ones |
| Partial setup writes | Single transaction (`save_parent_setup` RPC) |
| Partial deletion after promising "nothing is left" | Single transaction (`delete_parent_household` RPC) |
| Calling at an unreasonable hour | 08:00–21:00 in the parent's timezone, enforced inside `dialAndRecord` |
| Re-dialling a stranded row forever | Age-bounded, capped attempts |

Other properties worth knowing:

- **Failure is never silent.** A Vapi trigger failure routes into the same retry pipeline
  as a genuine no-answer rather than burning the retry budget. A notification that fails
  to send is recorded and shown to the caregiver as *"they were not notified"* — a
  caregiver believing family was told when the text silently failed is the worst outcome
  this system has.
- **Delayed ticks recover.** "Due by now" rather than a narrow window, with a catch-up
  cutoff so a badly-delayed tick reports a miss instead of placing a confusing call about
  a medication from hours ago.
- **DST-safe scheduling**, verified under a UTC system clock against both transition days.
- **Structured JSON logging** carrying `parent_id`/`call_id` through scheduler → dial →
  webhook → notification, so "why didn't Mom get her call?" is answerable by filtering
  logs rather than reading them.
- **The voice assistant's own configuration is audited**, because it is the one part of the
  system this repo cannot enforce. Four settings live only in the Vapi dashboard, which
  renders an unset field and a grey placeholder identically — a real incident here was a
  placeholder farewell list pasted into the field that is *spoken aloud*, and recording left
  unset (which Vapi treats as ON) on the assistant inbound calls reach, against a privacy
  page promising no audio is kept. `/admin` reads the live assistants on every load and
  reports prompt drift, recording, End Call settings and the consent tool. It never reports
  a check as passing when it could not read it, and its findings go to the operator banner —
  never to `/api/health`, where a 503 has to keep meaning "the scheduler is stale".

---

## Consent

California is all-party consent. On a parent's first call the assistant asks for
recording consent in its opening line, and the result is recorded via a Vapi tool →
`/api/vapi/consent` → `parents.consent_given_at`.

Until consent is recorded the scheduler places the first call (so Rosie can ask) but
blocks all *subsequent* automatic calls — it won't repeatedly cold-call someone who
hasn't agreed.

SMS opt-in for family contacts is a **separate** consent: the caregiver entering a
relative's number isn't that person's consent to be texted, so the setup form requires an
explicit per-contact confirmation, enforced client- and server-side. Documented publicly
at `/sms-consent`.

---

## Layout

```
/app
  page.tsx  privacy/  terms/  sms-consent/   public pages
  login/  auth/callback/                     Supabase magic-link auth
  setup/                                     caregiver setup wizard
  dashboard/                                 caregiver view: status, changes, history
  admin/                                     operator console (allowlist-gated)
  api/parents/                               setup save (one transaction) + load
  api/cron/tick/                             scheduler: due work, retries, reapers
  api/vapi/webhook/                          end-of-call: understand, decide, notify
  api/vapi/consent/                          records recording consent
  api/health/                                scheduler liveness (503 when stale)
/lib
  schedule.ts      timezone/DST-aware "what's due now", local day bounds
  dial.ts          places a call and records the outcome
  claude.ts        transcript → structured facts
  safety.ts        keyword + structural backstops, independent of the model
  insights.ts      change detection vs. baseline; alert fingerprints
  notify.ts        SMS + email fan-out, de-duplicated
  log.ts           structured JSON logging
/evals             scored evaluation set for transcript understanding
/supabase/migrations
```

### Data model

`caregivers` → `parents` → (`medications`, `appointments`, `family_contacts`,
`escalation_rules`, `calls` → `messages`).

Row-Level Security scopes everything to the signed-in caregiver (`caregivers.id =
auth.uid()`, the rest joining through `parents.caregiver_id`). The service-role client
bypasses RLS and is used only by `/api/parents` (which re-derives ownership from the
session, never the request body), the system-to-system cron/webhook routes, and `/admin`.
Any new route using that client must preserve the same invariant by hand.

`calls` is the audit trail; `messages` records every notification attempt including
failures, with the recipient denormalized so history survives a contact being removed.

---

## Setup

```bash
npm install
cp .env.local.example .env.local   # fill in real values
npm run dev
```

**Supabase** — create a project, run every file in `supabase/migrations/` in numeric
order, copy the keys from Settings → API.

**Vapi** — create an assistant and paste in `prompts/vapi-system-prompt.txt`, then set its
Server URL to `https://<deploy>/api/vapi/webhook` with an `x-webhook-secret` header. A free
Vapi number works; no Twilio number is needed for calling.

> The prompt lives in the repo but **does not deploy with it** — Vapi holds its own copy, so
> editing the file changes nothing until it is pasted into the dashboard. `npm run
> eval:conversation` scores the file, not what is live, so a green run on an unpasted change
> means nothing. Re-paste after every edit.

**Cron** — `/api/cron/tick` is a plain `CRON_SECRET`-protected route. Vercel's Hobby plan
only permits daily crons (and a sub-daily schedule in `vercel.json` hard-blocks
deployment there), so ping it every 5 minutes from an external scheduler with
`Authorization: Bearer <CRON_SECRET>`.

**Twilio/SendGrid** — only needed for alerts, not for calling.

| Variable | Source |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API |
| `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID` | Vapi dashboard |
| `VAPI_CALLBACK_ASSISTANT_ID` | Vapi dashboard — the assistant your phone numbers route *inbound* calls to. `/admin` audits its settings and shows a red incident until this is set. |
| `VAPI_WEBHOOK_SECRET` | Random string; must match the header on Vapi's Server URL |
| `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_FROM_NUMBER` | Twilio Console (API key, not the classic auth token) |
| `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` | SendGrid; sender must be verified |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `CRON_SECRET` | Random string, sent by whatever pings the scheduler |
| `ADMIN_EMAILS` | Comma-separated allowlist for `/admin`; unset means nobody has access |

Deployed on Vercel. `NEXT_PUBLIC_*` vars must be `Config` type, not `Secret`, since
they're exposed to the browser by design.

---

## Known limitations

Current and accurate:

- **Email to Gmail recipients is unreliable.** The SendGrid sender is a personal Gmail
  address via Single Sender Verification, and Gmail's DMARC policy means mail claiming to
  be `@gmail.com` but not sent through Google is silently dropped. Verified working to
  non-Gmail addresses. Fix is a real domain with SendGrid domain authentication.
- **Monitoring is pull-based** — `/api/health`, the dashboard banner, and `/admin` all
  require someone to look. Nothing pages you. Point an external uptime monitor at
  `/api/health` before this serves families who won't think to check.
- **The Vapi audit cannot confirm the consent tool.** The assistant payload carries tool
  ids and no names, and the panel deliberately makes no second request to resolve them, so
  that one row reads *unknown* rather than *ok*. Everything it cannot confirm it says so
  about, rather than guessing.
- **One parent per caregiver**, enforced by a unique constraint.
- **No long-term trends or digests** — change detection compares against a short rolling
  baseline, not months of history.
- **Not HIPAA-reviewed.** Direct-to-consumer tool, not a covered entity's system.
- **No opt-out keyword handling** (STOP/HELP) on outbound SMS.

## Not a medical service

This does not diagnose, treat, or advise. Rosie escalates information to humans and tells
anyone describing an emergency to call 911. See `/terms`.
