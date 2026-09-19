# Handover

Read this before touching the scheduler or the consent path. It is not a summary of work
done; it is the set of things that were expensive to learn.

---

## What this is

Rosie phones an aging parent daily, confirms medications and appointments, and texts the
family **only when something needs attention**. Silence is the product: a caregiver who
hears nothing should be able to conclude nothing is wrong. That single property is what
makes every bug in here worse than it looks — a suppressed alert, a false "doing okay", or
a call that silently never happens all read to the user as "everything is fine".

Next.js 16 · Supabase · Vapi (voice) · Twilio (SMS) · Anthropic (extraction) · Vercel.

---

## State as of this handover

- **There is uncommitted work in the tree.** The queue work is merged and deployed, but the
  Vapi configuration audit (`lib/vapi-config.ts`, `lib/vapi-audit.ts`,
  `lib/admin-incidents.ts`, their tests, `security/no-email.ts`, and edits to
  `app/admin/page.tsx`, `next.config.ts`, `README.md`, `.env.local.example` and the three
  security harnesses) is **not committed and not deployed** — deliberately, at the
  maintainer's instruction. Seven rounds of `/code-review` ran against it; every finding is
  fixed. Nothing in it touches the calling path: it is read-only monitoring plus harness
  fixes.
- The queue work is on `main` and live in production; eighteen
  rounds of `/code-review` ran against it, and every finding is either fixed or argued
  against in the commit that declined it.
- **Migrations 0001–0037 applied and verified against the live database.** `0031`,
  `0032` and `0033` were applied this session and confirmed through the API — 9/9 schema
  checks, including that the unique `(parent_id, due_at)` index really rejects duplicates,
  both CHECK constraints bite, and RLS hides `call_slots` from anon while the service role
  can still read it.
  - Not verifiable through PostgREST: whether `calls_transcript_retention_idx` was actually
    rebuilt on `created_at` by 0032. Index definitions aren't exposed, and it is a
    performance-only change with no behavioural signal. Everything else is confirmed.
- `npm run security` is **33/33**, `npm run security:refusal` **10/10**,
  `npm run security:queue` **41/41**, and **297 unit tests**.
- Twilio toll-free verification **approved**; SMS delivery works.
- Vapi: audio recording **off on both assistants**, transcripts on, `endCallFunctionEnabled`
  **true** on both, `endCallPhrases` **empty** on both. The system prompt in
  `prompts/vapi-system-prompt.txt` is pasted into the Vapi dashboard — **the repo is not
  the live copy**; re-paste after every edit. `lib/vapi.ts` sets no `endCallPhrases`,
  `endCallMessage` or `endCallFunctionEnabled` — those are dashboard-only state the repo
  cannot protect. Recording is the subtler one: `triggerVapiCall` **does** send
  `artifactPlan: { recordingEnabled: false, transcriptPlan: { enabled: true } }` on every
  outbound call, so the daily check-in is protected by the repo. The live bug was the
  **callback assistant**, which inbound calls reach without ever going through that
  function, so nothing sent it a per-call override — and Vapi treats *unset* as on. An
  assistant-level default is therefore load-bearing for every path that `triggerVapiCall`
  does not own. Verify them through the API (`GET https://api.vapi.ai/assistant`), not the
  dashboard — the dashboard renders an unset field and a placeholder identically, which is
  how the trap below went unnoticed.
- Production data: **one** real household (the maintainer's own parent — see Supabase for the
  name and number; deliberately not written down here, since this repo is public). A second
  test household was deleted this session via `delete_parent_household`.

---

## Deploying — read before the first tick

`0036` and `0037` are hard dependencies of the code on `main`; both are applied and
verified. Without `0036`, `recordPlanned` fails on every parent on every tick, which marks
the tick degraded, withholds the heartbeat and returns 500 — so `/api/health` goes red and
stays red. Calls still go out (the 500 happens after dispatch), but the alarm is jammed on.
Without `0037` (`calls.urgent`, `calls.outstanding_meds`) the webhook's insert fails
outright, so nothing about the call is ever written down.

## Older deploy notes

**`0034` is applied**, verified behaviourally rather than by schema read: an appointment was
deleted the way `save_parent_setup` deletes it, and the slot survived with `appointment_id`
nulled. Before it, `call_slots.appointment_id` cascaded, so any setup edit destroyed that
day's appointment slot, the next tick re-planned it, and it expired into a second "the
appointment reminder didn't go out" text about a day already reported.

**Pause the live households for the first tick.** The first tick after `0033` materialises
every already-elapsed slot for the local day (coverage started weeks ago for existing
households), and any slot with no matching `calls` row at that exact `due_at` expires
straight into a "check-in was missed" text. Old too-late rows share the fingerprint, but the
window for `safety` alerts is 4 hours, not 20, so alerts sent earlier that morning will not
suppress the replay. Pause, let one tick run, confirm `call_slots` looks sane, then resume.

---

## The /admin Vapi audit — what it is and why it exists

Four settings on the voice assistant are dashboard-only state that no code in this repo can
enforce, and **the Vapi dashboard renders an unset field and a grey placeholder
identically.** That is not theoretical: `End Call Message` held the placeholder farewell
list, pasted into the field that is spoken aloud, and read as empty to anyone looking at the
page. `recordingEnabled` was unset on the assistant inbound calls reach, which Vapi treats as
recording ON, against a `/privacy` page promising no audio is retained. Both were invisible
until someone read the raw JSON.

`/admin` now reads `GET /assistant/{id}` on every load and reports six things per assistant:
prompt drift against `prompts/vapi-system-prompt.txt`, recording explicitly off vs unset vs
on, End Call Phrases empty, End Call Message empty (or sane), the End Call function enabled,
and the `record_consent` tool. Findings go in the existing incident banner via
`lib/admin-incidents.ts`. **Deliberately not on `/api/health`:** a 503 there means the
scheduler is stale and pages whoever is on call, and overloading the one alarm that has to
stay trustworthy is how it gets ignored.

Three rules the module holds itself to, each learned the hard way:

- **Never a tick when it could not look.** A failed fetch, a missing key or an unreadable
  prompt file produces `unknown` on every row, never `ok`. A monitor that looks green when
  it failed to look converts an outage into a reassurance.
- **Expectations are per assistant.** The callback assistant is *supposed* to speak a
  farewell and *must not* carry `record_consent`; its prompt is not in this repo. Judging it
  by the check-in assistant's rules produces a permanently red banner, which nobody reads —
  the same failure mode as alerting a family about their normal.
- **"Not expected" is not "not looked at".** The consent-tool exemption runs one way: an
  assistant that never asks for consent but carries the tool that records it is flagged,
  because it could write a consent row for a call in which nobody was asked anything.

`VAPI_CALLBACK_ASSISTANT_ID` is a new variable (documented in `README.md` and
`.env.local.example`). Until it is set, `/admin` shows a red incident — correct, because the
unaudited assistant is the one that was found misconfigured in production.

Not covered, deliberately: the assistant payload carries tool **ids**, not names, and this
panel does not fetch `GET /tool`, so `record_consent` reads `unknown` rather than `ok`.
`toolNamesById` is the seam if that is ever worth a second request.

---

## Open work, in the order I'd do it

1. ~~**Merge and deploy the branch.**~~ **Done.** Production is on `main`. The live
   household's day under the new queue was inspected read-only and looks exactly as the dry
   run predicted: two `call_slots` rows, both `dispatched`, both linked to `completed` calls
   a minute apart. The pause-for-the-first-tick dance below is spent — keep it only as the
   procedure for the next scheduler migration.
2. **Point an external monitor at `GET /api/health`.** It returns 503 once the heartbeat is
   older than 15 minutes, is public (no auth, no middleware gate) and fails closed — a
   failed heartbeat read returns 503 rather than a green light. Nothing in this repo pages
   anyone; until something watches that URL, a dead scheduler is indistinguishable from a
   quiet week, which on this product is the whole failure mode. `cron-job.org` drives the
   tick, so its own alerting covers "the pinger stopped" but not "the tick is erroring".
3. **Commit and deploy the Vapi audit.** It is finished and reviewed but deliberately
   uncommitted. Before deploying, set `VAPI_CALLBACK_ASSISTANT_ID` in Vercel, or `/admin`
   will show a red incident from the first load. Also re-paste
   `prompts/vapi-system-prompt.txt` into the Vapi dashboard: the live copy currently carries
   five leftover lines of a developer note that was moved into `lib/greeting.ts`, and the
   audit reports it as drift — correctly.
4. **Out-of-hours medication rows.** A row predating the calling-hours check in
   `lib/validation.ts` can never be dialled. It is now reported by `planSlotsForDay` as
   `uncallable` and logged as `cron.slot_uncallable` rather than vanishing, but it still
   needs a backfill or a dashboard warning. Deliberately *not* queued: queueing it would
   expire unrung every night and text the family daily, which is worse than the status quo.
5. **Consent evidence is still a log line, not a durable row.** Re-checked against the live
   database: the household's number has **no `sms_opt_ins` row at all**, with messages
   already sent to it. That one number is simultaneously the caregiver, the parent *and*
   the family contact — and the contact row carries `sms_opt_in_confirmed = true` with no
   artifact behind it. Nothing is broken today (the caregiver's own number is first-party
   consent), but a confirmed flag asserting something no row supports is precisely what
   `0020` exists to prevent.

---

## The Vapi "End Call Phrases" trap — read before touching it

The previous handover said End Call Phrases contained `take care` and `have a good day` and
should be trimmed to `goodbye`. **That was a misread, and acting on it would have introduced
a bug rather than fixed one.**

- The field is **empty**. `goodbye,take care,have a good day` is Vapi's grey *placeholder*.
  Proof: editing another field produced a publish diff reporting `1 modified`. A real value
  being changed would appear there.
- Setting it to `goodbye` would be actively harmful. Phrases match **as a substring of the
  bot's transcript**, and the prompt tells Rosie to "say goodbye" in three places. A natural
  line like *"before we say goodbye, did you take your Metformin?"* contains the substring
  and hangs up mid-question — the same defect the trim was meant to remove, relocated.
  Vapi's own hint in that panel says to prefer multi-word phrases for this reason.
- **Near miss worth recording:** the obvious way to act on the old instruction is to paste
  the phrase list into the field, and the field directly *above* End Call Phrases is **End
  Call Message** — the sentence Rosie speaks aloud when hanging up. Pasting there was one
  click from publishing an assistant that says "goodbye comma take care comma have a good
  day" to an elderly person. Always read the publish diff before confirming.

Leave the field empty and end calls through the End Call function.

**Resolved, and the near miss was real.** Checked against the Vapi API rather than the
dashboard:

- **`End Call Message` on Rosie contained `goodbye,take care,have a good day ` — the
  placeholder list, pasted into the field that is spoken aloud, trailing space and all.**
  The near miss above was not avoided; it landed. It had never been audible only because
  nothing could trigger it, which means *enabling End Call is what would have made Rosie
  say it to an elderly person*. The two settings are coupled: clear the message first, then
  enable. Rosie's message is now empty — the transcripts show she closes naturally on her
  own — the pattern is "Take care, <name>. Goodbye for now." — and an End Call Message is
  spoken on top of that, so anything in the field is a second farewell. (Names and numbers
  from real transcripts do not belong in this file; the repo is public, and `0367473` had to
  strip one once already.)
- **No End Call tool existed and `endCallFunctionEnabled` was unset on every assistant.**
  The only tool on Rosie is `record_consent`. Evidence rather than inference: every real
  call ended `customer-ended-call` — the person hung up, every time. Rosie had never ended
  a call because she could not. Worst on **`Rosie — callback`** (both inbound numbers route
  to it), whose entire prompt is "say the first message, then end the call" — it could not
  do the only thing it is told to do. `endCallFunctionEnabled` is now true on both.
- **`End Call Phrases` is still empty on both, and must stay that way.** See the substring
  argument above.
- **Recording was off on Rosie but *unset* on `Rosie — callback`**, and Vapi's default is
  on — so an inbound callback could have been recorded while `/privacy` says "We do not
  retain audio recordings of the calls." Now explicitly false on both. **Set this on every
  assistant, not just the one `VAPI_ASSISTANT_ID` points at.**
- **The live prompt contains every line of the repo file** (0 missing). The live copy also
  carries one stale extra: the 9-line First Message dev note that was moved out of the repo
  into `lib/greeting.ts`. Harmless, but the model reads it — drop it on the next paste.

---

## Invariants that keep breaking

The same class of defect recurred five times across seven review rounds in one session.
These are the specific lessons, stated as rules.

### 1. A fact must be recorded *before* the operation that can fail, not after

The consent gate ("has this parent already been rung?") was wrong in production at least
twice, through three different columns — `status`, then `called_at`, then `vapi_call_id`.
Every one of those fixes read a value written by the **single post-dial update in
`lib/dial.ts`**, which is the exact write whose failure creates the situation the gate most
needs to know about. Migration `0027` added `calls.dial_attempted_at`, stamped *before*
`triggerVapiCall`. That is the first version that survived a review round.

**Rule:** if you need to know that something was attempted, write that down before
attempting it.

### 2. Mutually exclusive states belong in one state machine, not two guarded columns

Consent withdrawal was silently ignored **three times**. Each fix guarded the write on the
other column (`.is("consent_given_at", null)`, then `.is("consent_refused_at", null)`), and
each closed one path while leaving the next open. `app/api/vapi/consent/route.ts` now reads
the prior state, writes the new state unconditionally clearing its opposite, and decides
whether to notify by comparing before/after.

**Rule:** a guarded UPDATE that matches zero rows is indistinguishable from success. That is
how a person asking to be left alone got ignored, repeatedly.

The corollary, used throughout the new queue: when you *do* need a guarded update, add
`.select()` and read back whether it landed. `lib/dial.ts`'s refusal path and every
`call_slots` claim use this to decide whether *they* are the one who made the transition,
and therefore whether they owe anyone a message.

### 3. One rule, one place

"Does this warrant telling someone" existed in three hand-maintained copies that had
drifted — the dashboard's ignored mood, so a call that texted the family "needs a look"
rendered as "doing okay". Now `lib/alerting.ts`, used by the webhook, the dashboard and the
eval scorer. Same story for the spoken greeting (`lib/greeting.ts`), the calling-hours
window (`lib/callwindow.ts`), and now the "this slot is too late" fingerprint
(`tooLateFingerprint` in `lib/insights.ts`) — four paths can reach that conclusion for one
slot and they must dedupe against each other.

### 4. Enforce safety invariants at the chokepoint, not per caller

Three dial paths answered "is it too late to ring" three different ways and the most
dangerous had no answer at all. `lib/callwindow.ts` is enforced inside `dialAndRecord`,
which every path goes through, and refuses regardless of what the caller believes.

**But refusing is only half of it.** That refusal was terminal *and silent* for months: the
row was marked `failed` and left occupying `(parent_id, scheduled_for)`, so every later
tick's too-late branch hit a 23505 and continued without a word. A chokepoint that refuses
must also make the refusal into a fact somebody hears about.

### 4a. A one-shot alert must report whether it actually landed

`notifyFamilyContacts` used to return `void`. `expireLapsedSlots` claims the slot and links
the `calls` row *before* notifying, so there is no second attempt — and its opt-out read
fails *closed*: on a transient error it sends nothing and writes nothing, on the reasoning
that "the next attempt decides". For this caller there is no next attempt. One failed read
meant a genuinely missed check-in that nobody was ever told about, with the tick reporting
healthy. It now returns `false` when a recipient was skipped for a reason that is not a
decision (a failed opt-out, contacts, parent or caregiver read), and expiry degrades the
tick on it. Both the guard and its control are in `security/queue.ts`, mutation-tested.

Note the distinction: an opt-out, a dedupe hit and a Twilio delivery failure all return
`true`. Those are decisions or recorded facts. Only "we could not find out" is `false`.

### 4b. A fix is a change, and a change can defang the test that was watching it

Seven review rounds in one session, and the majority of what they found was **not in the
original code — it was in the previous round's fix.** The chain is worth reading in order,
because none of the individual steps looked careless:

1. The security harnesses were billing SendGrid on every run, so email was suppressed.
2. Suppression made a `status:'failed', channel:'email'` row appear on *every* alert, which
   silently satisfied `security/queue.ts`'s headline "TELLS THE FAMILY" assertion. It then
   passed with the SMS path deleted outright.
3. Narrowing that count to `channel = 'sms'` removed the row that had been keeping a
   neighbouring dedupe comparison non-zero, making a *different* vacuous pass reachable.
4. Hardening that dedupe assertion twice — a channel filter, then a `before > 0` term, each
   with a confident comment — distracted from the fact that it tested nothing at all:
   `expireLapsedSlots` selects `state = 'pending'`, the first pass had already claimed the
   slot to `'expired'`, so the second call never reached `notifyFamilyContacts`. It passed
   with the fingerprint dedupe deleted.
5. Fixing the channel filter in one harness while writing a comment saying "both counts now
   filter" left the identical defect in its sibling — three rounds running, each one finding
   another instance after the audit had been declared complete.

**Rules, stated so the next session does not repeat it:**

- After changing anything a test depends on, **re-derive that the test can still fail.**
  Break it deliberately and watch it go red. A passing suite after a fix proves nothing about
  whether the fix is covered.
- When you fix one instance of a defect, **grep for the class before writing that it is
  fixed.** Better, remove the ability to get it wrong: both harnesses now funnel every
  positive "the family was told" count through a single helper requiring
  `channel = 'sms'` AND `status = 'sent'`, rather than repeating a filter at each call site.
- **Delivered is not attempted.** A `failed` row is a Twilio outage, not a family that was
  told. Anti-vacuity guards must count successes, not rows.
- A comment claiming an audit is complete is a claim like any other, and **the ones that
  turned out to be false were all mine, written in the same commit as the fix.**

### 5. SQL NULL is not falsy

`.not("delivery_status", "in", "(undelivered,failed)")` is `NOT (NULL IN (...))` = NULL =
**no match**. It silently excluded 17 of 21 rows and disabled alert dedupe entirely — while
the comment directly above claimed nulls still counted. Use
`.or("col.is.null,col.not.in.(...)")`.

### 6. PostgREST rejects a limited UPDATE without `.order()`

The transcript retention sweep errored on every tick and only produced a log line, while
`/privacy` told people transcripts are deleted after 30 days.

### 7. Don't overload a column that the UI reads

`retry_count` meant two things, so a row re-dialled twice by the reaper arrived "exhausted"
and the family was told the parent didn't answer after 2 tries with no retry ever placed.
The fix moved the reaper onto `called_at` — which meant "the call was placed", is rendered
as "Called 9:03am" and "Last check-in", and was being stamped on calls that had never been
dialled. Migration `0032` gives the reaper its own `stale_redial_at`. Same mistake, twice,
one column over.

---

## How to verify (this is the part that actually worked)

Reading code found the shallow bugs. **Driving the running app found the ones that
mattered.**

```bash
npx next dev -p 3111                      # real .env.local: real Supabase, Vapi, Twilio
```

Three rules learned the hard way:

- **Never probe production records.** Earlier an exploit run against the real parent row
  wiped its medications and contacts. Create a throwaway household via `save_parent_setup`,
  drive it, delete it in a `finally`. `security/isolation.ts` is the pattern.
- **Pause the live household around any cron tick**, restoring in a `finally`. A tick places
  real phone calls to a real elderly person.
- **Use non-routable `+1202555xxxx` numbers.** Twilio accepts and never delivers, so the
  notify path runs for real without reaching a handset — **but every attempt is still a
  billed segment.** 303 of the 325 messages this account has ever sent went to probe
  numbers: all `undelivered`, all charged. That is the price of the fidelity, and it is
  worth paying; just know a full suite run is not free.
- **Probe households must not reach SendGrid at all.** `notifyFamilyContacts` alerts the
  account holder on *both* channels, and there is no free-to-attempt email address the way
  `+1202555xxxx` is a free-to-attempt *number* — SendGrid accepts an `@example.invalid`
  address, bills a credit, then blocks it as invalid. 107 of those in one day of review
  rounds exhausted the account's credits and took the **live** email channel down with it:
  real caregiver alerts started returning 401 while the suites went on passing. The product
  did not spend that budget; the verification code did. `security/no-email.ts` now unsets
  `SENDGRID_API_KEY` in-process, so `requireEnv` throws before any HTTP request; `sendAlert`
  already catches that and records the `status: 'failed'` row, so no product code changed.
  **Assertions did change.** A `failed` email row is now written on every alert, which
  silently satisfied any harness assertion that counted `messages` without filtering —
  including the headline "TELLS THE FAMILY" check in both `security/queue.ts` and
  `security/refusal.ts`, which passed green with the SMS path removed entirely. Three review
  rounds each found another instance after I had already written that the audit was
  complete, so every POSITIVE count now goes through one helper per harness —
  `deliveredSms` and `deliveredFor` — requiring `channel = 'sms'` **and** `status = 'sent'`.
  Delivered, not attempted: two `failed` SMS rows are a Twilio outage, not a family that was
  told. Negative `=== 0` controls stay unfiltered on purpose. It is also not free: `alreadyNotified` matches on `status = 'sent'`, so a `failed` row can
  never suppress a later one, which makes **email de-duplication untestable by construction**
  in all three suites — `security/refusal.ts`'s "does not tell anyone twice" check counts
  `sent` rows only and no longer sees the email channel. SMS dedupe is untouched and is what
  that check actually exercises. This was already the case while credits were exhausted; the
  change makes it permanent, so it is written down rather than left to be rediscovered.

**Take `now` as an argument.** This is what made the scheduler testable at all. `lib/queue.ts`
and `lib/slots.ts` accept the current time rather than calling `new Date()`, so
`security/queue.ts` drives a whole day — materialise, dispatch, expire, cancel — in a few
seconds against a throwaway household, without touching the clock or running a real tick.
The old scheduler could only be exercised by a real cron tick, which on this product means
phoning a real person, so in practice it never was — and it regressed in four of five
review rounds.

**A passing check proves nothing without a control.** Verify the negative *and* the
positive. "It didn't dial" is meaningless unless you also show it *would* have dialed with
one variable changed.

**Mutation-test new guards.** Break the guard, confirm the test fails, restore. Every guard
added this session was mutation-tested: silent refusal, a consumed slot, a silent expiry,
the local-day boundary, the calling-window clamp, and the coverage distinction each break
their tests when reintroduced.

---

## The trap that caught me nine times

**Nine tests in this codebase could not fail.** Every single one was in verification code:

- `EVAL_REPEATS=` (empty) → `Number("")` is 0 → every persona reported `✓ 0/0`, suite exited green having run nothing
- `medicationAccuracy` filtered failures containing `"med"` — `"confirmed"` ends in m-e-d and was excluded, `"missed"` was not, so failing to report every missed dose scored 100%
- `run.ts` gated only on concern recall, which a model returning pure garbage scores 100% on
- a missing judge verdict scored every `mustNot` as satisfied
- injection eval transcripts contained the keywords that made the backstop fire regardless
- the isolation suite asserted B couldn't read A's appointments — while the fixture seeded none
- the deletion check issued its own deletes then counted them
- "deleting one household doesn't touch another" compared `0` to `0`, because B had no household
- the deletion checks proved a *shared* number's consent survived, but nothing asserted the
  other half — a `delete_parent_household` that never touched `sms_opt_ins` at all would
  have passed all 28 checks

**It is still happening.** Two more this session, both in harnesses written the same day:

- a `med()` fixture that ignored its `overrides` argument, so every case in a new suite
  would have exercised the same default medication
- an "elapsed" slot seeded exactly `SLOT_CATCHUP_MINUTES` in the past — i.e. precisely at
  its own expiry — so a control asserting "expiry leaves unexpired slots alone" failed for a
  reason unrelated to the code under test

**And again, seven more times, in the session that added the /admin audit.** Every one was
in verification code, and every one was found by mutation rather than by reading:

- `security/queue.ts`'s "a second expiry pass does not re-alert" **passed with the
  fingerprint dedupe deleted**, because the second pass found no pending slot and never
  reached notify. It had been "hardened" twice in earlier rounds without anyone checking it
  could fail.
- Four separate "the family was told" counts were satisfied by a guaranteed-failed email
  row, and then by two failed SMS rows once the channel was filtered but the status was not.
- A test asserting an unreachable assistant keeps its labels covered the missing-key path
  and not the fetch-error path — the mutation it was written for survived.
- A `not.toContain("not the consent path")` assertion pointed at a string the repo had
  stopped emitting, so no implementation could fail it.
- A "does not leak the API key" control rejected with an error that never contained the key.
- A fixture spread the *audit result* into `raw` instead of the payload, so the test passed
  because every check failed, not because the one under test did.
- The `.trim()` in the prompt-unavailable guard had no test distinguishing it from `=== ""`.

Verification code is the one place a bug produces **no symptom**. Give it more suspicion
than product code, not less. **And mutation-test the guard the same hour you write it** —
five of the seven above were guards added earlier in the same session, believed covered.

**And the same applies to the edits themselves.** Several fixes in this branch were applied
with `str.replace()` and no assertion that the pattern matched. One of them — a revert that
stops an expired slot consuming its own alert — silently did nothing for two review rounds,
and the code read as if the fix were present because the comment describing it landed
elsewhere. If you patch by search-and-replace, assert the match count, and re-read the
result. A no-op edit and a successful one look identical afterwards.

---

## The scheduler, after the redesign

`medsDueNow` answered "was this slot ever due today", which stays true for the rest of the
day after the slot is handled, missed, or abandoned. Everything built on top of it existed
to reconstruct facts nothing had written down. That is gone. Migration `0033` materialises
the day's calls as rows with explicit `due_at`/`expires_at`, and the tick is three passes:

```
lib/slots.ts   planSlotsForDay()  — pure. What today should look like.
lib/queue.ts   materializeSlots() — write it down (idempotent via unique (parent_id, due_at))
               dispatchDueSlots() — ring what is due
               expireLapsedSlots()— account for what lapsed, once
               cancelPendingSlots() — drop the rest when we stop being responsible
```

Deleted: `MAX_CATCHUP_MINUTES` (now a per-row `expires_at`), both "too late" branches,
`hasCoveredCallToday`. 74 insertions, 208 deletions in the tick route.

**Two things the previous handover predicted would disappear, which did not, and must not:**

- **`coverageStartsAt` and `resumed_at` survive.** "This slot already passed" and "were we
  responsible for it" are different questions. A slot that elapsed during a pause was never
  ours to miss; a slot that elapsed because the scheduler was down absolutely was, and the
  family needs telling. Materialising only future slots collapses both into silence — the
  one direction this product must never fail in. There is a test pair pinning both.
- **The queue is its own table, not a `'queued'` status on `calls`.** `calls.status` is read
  by `parents_with_calls` — the consent gate that has been wrong in production three times.
  A scheduler rewrite and a fourth status on the table that gate reads do not belong in one
  blast radius.

Two behaviours worth knowing:

- A dispatch that doesn't result in a call (blocked by an in-flight call, a provider error)
  **releases the slot back to `pending`** rather than consuming it. Expiry is then the single
  place that declares a slot missed. A consumed slot is a check-in that silently never
  happens.
- `expires_at` is `min(due_at + SLOT_CATCHUP_MINUTES, end of the calling window that day)`,
  so the queue never asks for a dial that `lib/dial.ts` would refuse.

---

## Known design debt (deliberate, not forgotten)

- Out-of-hours medication rows — see *Open work* 4.
- Consent evidence — see *Open work* 5.
- The `/admin` audit reports `record_consent` as **unknown**, permanently. The assistant
  payload carries tool ids and no names, and the panel deliberately does not fetch
  `GET /tool`. `auditAssistant` accepts a `toolNamesById` map (and is tested with one) if
  that second request is ever judged worthwhile.
- The audit's two HTTP calls share `/admin`'s `Promise.all`, so their latency overlaps the
  database reads rather than adding to them — but `await Promise.all` still gates the render
  on the slowest member, so a Vapi outage delays the scheduler banner by up to the 8s
  timeout. A `<Suspense>` boundary around the panel is the real fix and was deliberately not
  taken.
- `retry_count` still means "no-answer retries" only. The stale reaper now has its own
  column (`stale_redial_at`, 0032) and bounds by age.
- A completed call covers a *new* medication slot only within `SLOT_MERGE_MINUTES` of it and
  only for the medication names that call was about (`materializeSlots`). Widening either
  bound silences the evening dose of the same drug; dropping the check entirely lets a
  mid-morning setup edit place a second real call about a dose confirmed minutes earlier.
- `call_slots` is not surfaced anywhere in the UI. RLS already allows a caregiver to read
  their own, so a "what's scheduled today" panel is a small change if it's ever wanted.

---

## Commands

```bash
npm test                  # 297 unit tests
npm run security:all      # all three real-database suites, below, in order
npm run security          # 33 tenant-isolation checks against real Supabase
npm run security:refusal  # 10 checks: an out-of-hours refusal must alert the family
npm run security:queue    # 41 checks: the call queue, driven with a controlled clock
npm run eval              # 19 summarizer cases (costs Anthropic tokens)
npm run eval:conversation # 8 personas x3 against the real system prompt (costs tokens, slow)
npx next build
```

The three `security*` suites each create and clean up their own throwaway household against
the real Supabase project. None of them run a cron tick, so none can call a real person, and
none can reach SendGrid (`security/no-email.ts`). They do place billed Twilio segments — see
the note under *How to verify*.

There is no command for the Vapi audit: it runs on every `/admin` load, read-only. To see it
from a terminal, call `auditVapiAssistants()` from a scratch script with `.env.local`
sourced. It issues `GET` requests only — never PATCH a live assistant from a script.

`npm run eval:conversation` scores `prompts/vapi-system-prompt.txt`, **not** what is live in
Vapi. A green run on an unpasted change means nothing.

---

## Operational notes

- The user applies migrations by hand and reports "done". **Always verify via the API
  before trusting it** — this has been wrong more than once, and `0025` partially applied
  (statement-by-statement) while appearing to fail. Verify the *constraints*, not just that
  the table exists: insert a duplicate and check for 23505, insert a bad enum and check it
  is rejected, read as anon and check RLS bites, and read as the service role as a control.
- Never rewrite a SQL function from a partial read. `0025` reconstructed
  `save_parent_setup` from ~16 visible lines of a 90-line body, introduced six differences,
  and took the setup form down in production. Copy the original, edit one clause.
- Every `drop function` + `create` re-grants EXECUTE to PUBLIC. Re-apply the revoke, or you
  silently re-open the anon-key hole `0018` was written to close. Nothing in the isolation
  suite covers `delete_parent_household`'s grants — that was checked by hand this session
  (anon gets `42501`, service role reaches the body) and is not guarded by anything standing.
