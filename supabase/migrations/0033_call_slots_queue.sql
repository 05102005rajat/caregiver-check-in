-- The day's calls, materialised once, with explicit due_at/expires_at.
--
-- WHY THIS EXISTS
--
-- medsDueNow answers "was this slot ever due today", and that stays true for the rest of
-- the day after the slot has been handled, failed, or given up on. Every consequence of
-- that one property had to be reconstructed on every tick, in code:
--
--   MAX_CATCHUP_MINUTES        how late is too late, checked in three places
--   two "too late" branches    one for medications, one for appointments, each with its
--                              own insert, its own 23505 handling and its own fingerprint
--   coverageStartsAt           max(paused_until, resumed_at, first_call_after, created_at),
--                              recomputed per tick to decide what we were responsible for
--   hasCoveredCallToday        an extra query per parent, to stop the appointment fallback
--                              double-calling after a medication call
--   resumed_at                 a column that exists only to feed coverageStartsAt
--
-- A slot is a fact with a lifetime: it becomes due, it stays callable for a while, then it
-- stops being callable. Written down once as a row, every one of those mechanisms is a
-- column comparison instead of a derivation. This is the change HANDOVER.md calls the
-- highest-leverage one in the repo.
--
-- WHY A SEPARATE TABLE, NOT A 'queued' STATUS ON calls
--
-- `calls.status` is read by parents_with_calls (the consent gate), by
-- calls_parent_active_unique, and by the dashboard's most-recent-calls list. The consent
-- gate has been wrong in production three times, through three different columns. Adding a
-- fourth status to the table it reads, in the same change that rewrites the scheduler,
-- would put two independently risky things in one blast radius. A `calls` row still means
-- exactly what it meant before: we tried to ring someone. Slots live next to it.

create table if not exists call_slots (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references parents(id) on delete cascade,

  -- When this slot should be rung, and the instant after which ringing about it stops
  -- making sense and it becomes a miss. Both absolute, both decided when the row is
  -- created, so no later code re-derives "is it too late" from a duration constant.
  due_at timestamptz not null,
  expires_at timestamptz not null,

  kind text not null check (kind in ('medication', 'appointment')),

  -- Snapshot of what the call is for, so a later edit to the medication list can't
  -- retroactively change what an already-materialised slot was about — the same reasoning
  -- as calls.scheduled_meds.
  med_names text[] not null default '{}',
  appointment_id uuid references appointments(id) on delete cascade,

  -- One column, mutually exclusive values. Two independent booleans ("dispatched",
  -- "expired") is the shape that let consent withdrawal be silently ignored three times:
  -- a guarded UPDATE that matches zero rows is indistinguishable from success.
  state text not null default 'pending' check (state in ('pending', 'dispatched', 'expired', 'cancelled')),

  -- Set when the slot is dispatched, so a slot and the call it produced are traceable both
  -- ways. ON DELETE SET NULL because the retention sweep may outlive the slot.
  call_id uuid references calls(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Materialisation runs on every tick and must be idempotent. This is what makes it so:
  -- the second attempt to create a slot conflicts instead of duplicating it, exactly as
  -- calls_parent_scheduled_for_key does for calls.
  unique (parent_id, due_at)
);

-- The tick's two hot queries: "what is due now" and "what has expired".
create index if not exists call_slots_pending_idx on call_slots (due_at) where state = 'pending';
create index if not exists call_slots_parent_idx on call_slots (parent_id, due_at);

alter table call_slots enable row level security;

-- Same shape as every other table here: scoped through parents.caregiver_id. Read-only for
-- caregivers; only the service role writes. Nothing in the app reads this as a caregiver
-- yet, but a table whose default is "no policy, invisible" becomes a debugging dead end the
-- first time someone wants it on the dashboard, and an over-broad policy added in a hurry
-- then is worse than a correct narrow one now.
drop policy if exists "caregivers can read their parents' call slots" on call_slots;

create policy "caregivers can read their parents' call slots"
  on call_slots for select
  using (parent_id in (select p.id from parents p where p.caregiver_id = auth.uid()));
