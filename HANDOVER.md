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

- Branch **`scheduler-queue-and-review-fixes`**, several commits ahead of `main` (`f6e23be`).
  **Not merged, not deployed.** Merge with
  `git checkout main && git merge --ff-only scheduler-queue-and-review-fixes`.
  Eight rounds of `/code-review` ran against this branch; every finding is either fixed or
  argued against in the commit that declined it.
- **Migrations 0001–0035 applied and verified against the live database; `0036` is NOT applied.** `0031`,
  `0032` and `0033` were applied this session and confirmed through the API — 9/9 schema
  checks, including that the unique `(parent_id, due_at)` index really rejects duplicates,
  both CHECK constraints bite, and RLS hides `call_slots` from anon while the service role
  can still read it.
  - Not verifiable through PostgREST: whether `calls_transcript_retention_idx` was actually
    rebuilt on `created_at` by 0032. Index definitions aren't exposed, and it is a
    performance-only change with no behavioural signal. Everything else is confirmed.
- `npm run security` is **33/33** (was 27/28). Two new runtime suites:
  `npm run security:refusal` (10/10) and `npm run security:queue` (35/35). 178 unit tests.
- Twilio toll-free verification **approved**; SMS delivery works.
- Vapi: audio recording **off**, transcripts on. The system prompt in
  `prompts/vapi-system-prompt.txt` is pasted into the Vapi dashboard — **the repo is not
  the live copy**; re-paste after every edit. `lib/vapi.ts` sets no `endCallPhrases` or
  `endCallMessage`, so those are dashboard-only state the repo cannot protect.
- Production data: **one** household, `manju`, on `+19494660665`. The `man` test household
  was deleted this session via `delete_parent_household`.

---

## Deploying — read before the first tick

**`0036` is a hard dependency of the code on `main`.** Without it, `recordPlanned` fails on
every parent on every tick, which marks the tick degraded, withholds the heartbeat and
returns 500 — so `/api/health` goes red and stays red. Calls still go out (the 500 happens
after dispatch), but the alarm is jammed on. Apply it before deploying.

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

## Open work, in the order I'd do it

1. **Merge and deploy the branch**, pausing the live household for the first tick as
   described above. Watch the first tick after 17:57 PDT — `manju`'s first slot under the new
   queue. Expected: two `call_slots` rows, two calls a minute apart, same as before. A
   read-only dry run of the planner against the live household produced exactly that.
2. **Confirm an End Call tool exists in the Vapi Tools tab.** `End Call Phrases` is empty
   (see below), so that tool is the only thing that lets Rosie hang up deliberately — and
   the consent-refusal path in `prompts/vapi-system-prompt.txt:21` ("tell them you won't
   ring again, say goodbye, and end the call") depends on it. If it isn't enabled, that
   promise has no mechanism behind it.
3. **Out-of-hours medication rows.** A row predating the calling-hours check in
   `lib/validation.ts` can never be dialled. It is now reported by `planSlotsForDay` as
   `uncallable` and logged as `cron.slot_uncallable` rather than vanishing, but it still
   needs a backfill or a dashboard warning. Deliberately *not* queued: queueing it would
   expire unrung every night and text the family daily, which is worse than the status quo.
4. **Consent evidence is still a log line, not a durable row** — and there is now a
   concrete instance. `+19494660665` has **no `sms_opt_ins` row at all**, before or after
   the `man` deletion, yet 23 messages have been sent to it. Nothing is broken today
   (the caregiver's own number is first-party consent), but the artifact `0020` exists to
   produce does not exist for the live household.

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

Leave the field empty and end calls through the End Call Tool.

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
  notify path runs for real without reaching a handset.

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

Verification code is the one place a bug produces **no symptom**. Give it more suspicion
than product code, not less.

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

- Out-of-hours medication rows — see *Open work* 3.
- Consent evidence — see *Open work* 4.
- `retry_count` still means "no-answer retries" only. The stale reaper now has its own
  column (`stale_redial_at`, 0032) and bounds by age.
- `call_slots` is not surfaced anywhere in the UI. RLS already allows a caregiver to read
  their own, so a "what's scheduled today" panel is a small change if it's ever wanted.

---

## Commands

```bash
npm test                  # 139 unit tests
npm run security:all      # all three real-database suites, below, in order
npm run security          # 33 tenant-isolation checks against real Supabase
npm run security:refusal  # 10 checks: an out-of-hours refusal must alert the family
npm run security:queue    # 35 checks: the call queue, driven with a controlled clock
npm run eval              # 19 summarizer cases (costs Anthropic tokens)
npm run eval:conversation # 8 personas x3 against the real system prompt (costs tokens, slow)
npx next build
```

The three `security*` suites each create and clean up their own throwaway household against
the real Supabase project. None of them run a cron tick, so none can call a real person.

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
