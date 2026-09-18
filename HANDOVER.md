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

- `main` @ `7527c47`, deployed, healthy (cron ticking every ~5 min via cron-job.org).
- **Migrations 0001–0030 applied. `0031` is NOT applied.**
  `npm run security` is deliberately red at **27/28** until it is — the failing check is
  real (see *Open work*).
- Twilio toll-free verification **approved**; SMS delivery works.
- Vapi: audio recording **off** (`artifactPlan.recordingEnabled: false`, now also set per
  call in `lib/vapi.ts`), transcripts on. The system prompt in `prompts/vapi-system-prompt.txt`
  is pasted into the Vapi dashboard — **the repo is not the live copy**; re-paste after
  every edit.
- Production data: two households, both pointed at the same real phone (`+19494660665`).
  `manju` is the real one. `man` is leftover test data — see *Open work*.

---

## Open work, in the order I'd do it

1. **Apply `0031_delete_household_scoping.sql`.** Deleting one household currently destroys
   another household's SMS consent record for any shared phone number (two adult children
   listing the same sibling). The isolation suite proves it.
2. **Delete the `man` household** if the user confirms. Nothing depends on it; it has one
   medication at 22:48 which is now outside the calling window and can never fire. Use
   `delete_parent_household` — a good first real exercise of it.
3. **The `medsDueNow` redesign.** Deliberately deferred; see *Known design debt*.
4. **Vapi dashboard: trim End Call Phrases** to just `goodbye`. It currently contains
   `take care` and `have a good day`, which hang up the call when Rosie says them warmly
   mid-conversation.

---

## Invariants that keep breaking

Seven review rounds happened in one session. The same class of defect recurred five times.
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

### 3. One rule, one place

"Does this warrant telling someone" existed in three hand-maintained copies that had
drifted — the dashboard's ignored mood, so a call that texted the family "needs a look"
rendered as "doing okay". Now `lib/alerting.ts`, used by the webhook, the dashboard and the
eval scorer. Same story for the spoken greeting (`lib/greeting.ts`) and the calling-hours
window (`lib/callwindow.ts`).

### 4. Enforce safety invariants at the chokepoint, not per caller

Three dial paths answered "is it too late to ring" three different ways and the most
dangerous had no answer at all. `lib/callwindow.ts` is enforced inside `dialAndRecord`,
which every path goes through, and refuses regardless of what the caller believes.

### 5. SQL NULL is not falsy

`.not("delivery_status", "in", "(undelivered,failed)")` is `NOT (NULL IN (...))` = NULL =
**no match**. It silently excluded 17 of 21 rows and disabled alert dedupe entirely — while
the comment directly above claimed nulls still counted. Use
`.or("col.is.null,col.not.in.(...)")`.

### 6. PostgREST rejects a limited UPDATE without `.order()`

The transcript retention sweep errored on every tick and only produced a log line, while
`/privacy` told people transcripts are deleted after 30 days.

---

## How to verify (this is the part that actually worked)

Reading code found the shallow bugs. **Driving the running app found the ones that
mattered**, including two HIGH regressions shipped 30 minutes earlier.

```bash
npx next dev -p 3111                      # real .env.local: real Supabase, Vapi, Twilio
```

Then drive the real HTTP surface. Three rules learned the hard way:

- **Never probe production records.** Earlier in this session an exploit was run against the
  real parent row and wiped its medications and contacts. Create a throwaway household via
  `save_parent_setup`, drive it, delete it. `security/isolation.ts` is the pattern.
- **Pause the live households around any cron tick**, restoring in a `finally`. A tick
  places real phone calls to a real elderly person.
- **Use non-routable `+1202555xxxx` numbers.** Twilio refuses them, so the notify path runs
  for real without reaching a handset.

**A passing check proves nothing without a control.** Verify the negative *and* the
positive — "it didn't dial" is meaningless unless you also show it *would* have dialed with
one variable changed. One control attempt in this session was itself invalid (a silently
failed `DELETE` left a stale row blocking the dial for an unrelated reason); `scheduled_meds:
null` in the output is what gave it away.

**Mutation-test new guards.** Break the guard, confirm the test fails, restore.

---

## The trap that caught me nine times

**Nine tests in this codebase could not fail.** Every single one was in verification code:

- `EVAL_REPEATS=` (empty) → `Number("")` is 0 → every persona reported `✓ 0/0`, suite exited green having run nothing
- `medicationAccuracy` filtered failures containing `"med"` — `"confirmed"` ends in m-e-d and was excluded, `"missed"` was not, so failing to report every missed dose scored 100%
- `run.ts` gated only on concern recall, which a model returning pure garbage scores 100% on (unparseable → mood `"unknown"` → counts as alerting)
- a missing judge verdict scored every `mustNot` as satisfied
- injection eval transcripts contained the keywords that made the backstop fire regardless
- the isolation suite asserted B couldn't read A's appointments — while the fixture seeded none
- the deletion check issued its own deletes then counted them
- "deleting one household doesn't touch another" compared `0` to `0`, because B had no household

Verification code is the one place a bug produces **no symptom**. Give it more suspicion
than product code, not less. When you write a test, break the thing it guards and watch it
fail.

---

## Known design debt (deliberate, not forgotten)

**`medsDueNow` is cumulative for the whole local day.** Because "was this slot ever due
today" stays true after the slot is handled or failed, the scheduler needs
`MAX_CATCHUP_MINUTES`, two separate "too late" branches with their own inserts and
fingerprints, `coverageStartsAt` (built from `max(paused_until, resumed_at, first_call_after,
created_at)`), `hasCoveredCallToday`, and the `resumed_at` column. A queue that materialises
the day's rows once with explicit `due_at`/`expires_at` deletes all of it.

This is the highest-leverage change in the repo and it was **deliberately not done** at the
end of a long session: it is a rewrite of the file that regressed in four of five review
rounds, on the path that calls a real person daily. Do it as the only task in a session,
with the runtime harness driving it.

Smaller, also deliberate:
- Existing medication rows outside 08:00–21:00 are rejected on *new* saves only. An old
  one silently never calls and never alerts. Needs a backfill or a dashboard warning.
- `retry_count` was overloaded by two different mechanisms; the stale reaper now bounds by
  age instead, but the column still means "no-answer retries" only.
- Consent evidence is a log line, not a durable row.

---

## Commands

```bash
npm test                  # 126 unit tests
npm run security          # 28 tenant-isolation checks against real Supabase
npm run eval              # 19 summarizer cases (costs Anthropic tokens)
npm run eval:conversation # 8 personas x3 against the real system prompt (costs tokens, slow)
npx next build
```

`npm run eval:conversation` scores `prompts/vapi-system-prompt.txt`, **not** what is live in
Vapi. A green run on an unpasted change means nothing.

---

## Operational notes

- The user applies migrations by hand and reports "done". **Always verify via the API
  before trusting it** — this has been wrong more than once, and `0025` partially applied
  (statement-by-statement) while appearing to fail.
- Never rewrite a SQL function from a partial read. `0025` reconstructed
  `save_parent_setup` from ~16 visible lines of a 90-line body, introduced six differences,
  and took the setup form down in production. Copy the original, edit one clause.
- Every `drop function` + `create` re-grants EXECUTE to PUBLIC. Re-apply the revoke, or you
  silently re-open the anon-key hole `0018` was written to close.
