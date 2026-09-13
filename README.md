# Caregiver Check-In

A web app where a caregiver sets up daily check-in calls for a parent or loved one. A
scheduler calls the parent at the right times, confirms medications and appointments via
an AI voice assistant (Vapi), and texts the family only when something needs attention.

Full product spec: see `mvp-build-spec.md` if present, or the commit history — this repo
was built incrementally against that spec, evening by evening.

## What it does

1. A caregiver signs in (Supabase magic-link auth) and fills out `/setup`: their own
   info, their parent's info, medications (with times and an optional "how to recognize
   it" description), appointments, family contacts to notify, and escalation rules.
2. A scheduler (`/api/cron/tick`, pinged externally every 5 minutes) finds medications
   due in the next 5-minute window and places an outbound call via Vapi.
3. The Vapi assistant ("Rosie") has a warm, scripted conversation: confirms meds, checks
   in on appointments, asks if anything's needed, reads back what it heard.
4. When the call ends, Vapi POSTs an end-of-call report to `/api/vapi/webhook`, which:
   - Marks a no-answer/voicemail for retry (the cron retries per `escalation_rules`,
     and sends a miss-alert SMS once retries are exhausted).
   - Otherwise summarizes the transcript via Claude into structured JSON (meds
     confirmed/missed, concerns, mood), **plus a deterministic keyword scan** of the
     raw transcript as a backstop in case Claude fails or under-classifies.
   - Texts family contacts only if something was missed or concerning ("no news is
     good news" — a clean call sends no text).
5. The caregiver can check `/dashboard` at any time to see recent calls (status,
   summary, meds confirmed/missed, concerns) and expand any call's full transcript,
   plus a health banner if the scheduler has gone quiet or a call is stuck.

## First-call consent (spec section 8)

California is all-party consent, so the assistant asks for it before doing anything
else on a parent's very first call: *"Is now a good time to talk... this call may be
recorded so your family can check summaries later — is that okay?"* (see the system
prompt). The result is reported back via the `record_consent` Vapi Tool →
`app/api/vapi/consent/route.ts`, which stamps `parents.consent_given_at`.

Until consent is recorded, `/api/cron/tick` still places the first call (so Rosie has a
chance to ask), but blocks all *subsequent* automatic scheduled calls
(`consentBlocksNewCalls` in `app/api/cron/tick/route.ts`) — it won't keep cold-calling a
parent who hasn't consented. The caregiver's manual "Call now to test" button can also
be used to (re)obtain consent if the first real call didn't get a clear answer.

## Monitoring

`/api/health` reports unhealthy (503) if `/api/cron/tick` hasn't run in the last 15
minutes (point an external uptime monitor at it if you want a ping/alert outside the
app). The `/dashboard` page shows the same signal as a banner, plus flags any call
that's been stuck `in_progress` for more than 10 minutes — check it periodically
instead of relying solely on family SMS, since a clean call intentionally sends no
text ("no news is good news").

## Architecture

```
/app
  /page.tsx                    landing page
  /login, /auth/callback       Supabase magic-link auth
  /setup                       the caregiver setup form
  /api/parents                 saves the setup form (upserts caregiver+parent,
                                replaces meds/appointments/contacts/rules)
  /api/cron/tick                the scheduler: finds due meds, dials, retries
  /api/vapi/webhook             end-of-call handling: summarize, notify, retry-mark
/lib
  /supabase/{client,server,middleware,admin}.ts   Supabase clients (browser/server/
                                                    proxy-session-refresh/service-role)
  /schedule.ts                 timezone-aware "what's due now" + local-time helpers
  /vapi.ts                     triggers an outbound Vapi call
  /claude.ts                   transcript -> structured summary via Anthropic API
  /twilio.ts                   sends SMS via Twilio's REST API (API Key auth)
  /notify.ts                   texts every family contact with a given notify flag
  /safety.ts                   deterministic concern-keyword scan (Claude backstop)
  /format.ts                   shared meds/appointments -> human-readable string
/types/db.ts                    TypeScript types mirroring the Supabase schema
/supabase/migrations           SQL migrations, run in order against your Supabase project
```

## Data model

Postgres tables (see `supabase/migrations/`): `caregivers`, `parents`, `medications`,
`appointments`, `family_contacts`, `escalation_rules`, `calls`, `messages`. Row-Level
Security scopes every table to the logged-in caregiver's own data
(`caregivers.id = auth.uid()`, everything else joins through `parents.caregiver_id`).
API routes that need to write across a caregiver's own boundary (`/api/parents`) or
write system-generated data the caregiver only reads (`calls`, `messages`, written by
the cron/webhook routes) use the service-role client, which bypasses RLS — those two
routes are the only places that invariant needs to be preserved.

`calls` is the audit trail: `scheduled_for`, `called_at`, `status`, `retry_count`,
`vapi_call_id`, `transcript`, `summary`, `meds_confirmed`, `concerns`.

## Environment variables

See `.env.local.example` for the full list. Summary of where each comes from:

| Variable | Where to get it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase project → Settings → API |
| `VAPI_API_KEY` | Vapi dashboard → API Keys (the **private** key) |
| `VAPI_ASSISTANT_ID` | Vapi → your assistant's page |
| `VAPI_PHONE_NUMBER_ID` | Vapi → Phone Numbers → your number |
| `VAPI_WEBHOOK_SECRET` | Any random string you generate — must match the `x-webhook-secret` HTTP header configured on the Vapi phone number/assistant's Server URL |
| `TWILIO_ACCOUNT_SID` | Twilio Console → Account |
| `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` | Twilio Console → API keys & tokens → Create API key (used instead of the classic Auth Token) |
| `TWILIO_FROM_NUMBER` | A Twilio number capable of SMS (only needed once escalation texts are in use — outbound calling itself uses Vapi's own number, not Twilio) |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `CRON_SECRET` | Any random string you generate — sent as `Authorization: Bearer <value>` by whatever pings `/api/cron/tick` |

## Supabase setup

1. Create a free project at supabase.com.
2. SQL Editor → run each file in `supabase/migrations/` **in numeric order**.
3. Settings → API → copy the three keys into `.env.local` / your deploy target's env vars.

## Vapi setup

1. Create an assistant, paste the system prompt (see the spec / commit history for the
   exact text), set voice/model/max-duration.
2. Get a phone number: **Free Vapi Number** works with no Twilio number needed at all.
   (Twilio trial accounts no longer include a free usable number — importing one
   requires adding funds to Twilio, which isn't necessary just to make calls.)
3. On the phone number (or assistant), set **Server URL** to
   `https://<your-deploy>/api/vapi/webhook` and add an HTTP header
   `x-webhook-secret: <your VAPI_WEBHOOK_SECRET>`.

## Twilio setup (only needed for SMS escalation)

Calling works entirely through Vapi's own number. Twilio is only needed once you want
the actual miss-alert/concern SMS to send: buy/verify a number capable of SMS, set
`TWILIO_FROM_NUMBER`, and note Twilio trial accounts require adding funds to get a
real usable number (the trial's demo/playground number shown on the dashboard is not
an owned number and can't be imported into Vapi or used to send SMS).

## Cron

`/api/cron/tick` is a plain `CRON_SECRET`-protected route, not tied to any specific
scheduler. **Vercel's Hobby plan only allows daily cron jobs**, so `vercel.json`
intentionally does not declare a cron (a sub-daily schedule there hard-blocks
deployment on Hobby). Instead, ping the route every 5 minutes from an external
scheduler (e.g. cron-job.org) with header `Authorization: Bearer <CRON_SECRET>`.

## Local development

```bash
npm install
cp .env.local.example .env.local   # fill in real values
npm run dev
```

## Production deployment

Deployed via Vercel, connected to this GitHub repo for auto-deploy on push to `main`.
Set every env var in Vercel (Project Settings → Environment Variables) across
Production/Preview/Development before the first deploy — `NEXT_PUBLIC_*` vars must be
added as `Config` type (not `Secret`), since they're exposed to the browser by design.

## Security notes

- RLS is the primary access boundary for anything a caregiver reads/writes directly.
- `/api/parents`, `/api/cron/tick`, and `/api/vapi/webhook` use the service-role client
  (bypasses RLS) — `/api/parents` re-derives the caregiver id from the authenticated
  session (`auth.uid()`) before writing, and the other two are system-to-system routes
  gated by their own shared secrets, not user auth. Any future route added to this
  admin-client pattern needs to preserve that same "derive ownership, don't trust the
  request body" invariant manually.
- Concern detection is **not purely LLM-based**: `lib/safety.ts` runs a deterministic
  keyword scan (`escalation_rules.concern_keywords`) alongside Claude's classification,
  specifically so a Claude outage or misclassification can't silently drop a real
  emergency mention.

## Known limitations (v1, matches spec section 10)

- One parent per caregiver (enforced via a DB unique constraint).
- No daily digest, no mood trends over time.
- Not HIPAA-reviewed — this is a direct-to-consumer tool, not a covered entity's system.
- Setup writes (`/api/parents`) are not atomic across all five tables — a failure
  partway through is designed to never *lose* existing data (new rows are inserted
  before old ones are deleted), but isn't a single transaction. A Postgres RPC wrapping
  the whole operation in `BEGIN`/`COMMIT` would close this gap.
- Monitoring is pull-based (`/api/health` + the `/dashboard` banner), not push —
  nothing pages you automatically if you don't check. Fine for a single household
  watching its own dashboard; wire `/api/health` into an external alerting service
  before this serves people who won't think to check.
