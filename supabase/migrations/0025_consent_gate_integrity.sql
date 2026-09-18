-- Three consent-gate defects, all of which end in the same place: calling someone who
-- never agreed to be called, and recording them.

-- ---------------------------------------------------------------------------
-- 1. The gate was erasing the evidence that closed it.
--
-- parents_with_calls (0024) defined "has ever been called" as status <> 'failed'. The
-- consent-blocked branch in the scheduler then closed out stranded rows by setting them to
-- 'failed' — so closing the gate deleted the very fact that closed it. A parent who never
-- consented and simply didn't answer went: tick 1 dials, tick 2 closes the gate and flips
-- the row, tick 3 sees no prior calls and the gate is open again. Confirmed by running it.
--
-- Status is mutable bookkeeping and makes a bad primary signal. called_at is not: it is
-- stamped when a dial is actually attempted and nothing rewrites it afterwards. Rows that
-- never dialled (the "too late to call" placeholders, which are inserted as 'failed' with
-- no called_at) still correctly read as "never called".
drop function if exists public.parents_with_calls(uuid[]);

create function public.parents_with_calls(p_parent_ids uuid[])
returns table (parent_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select distinct c.parent_id
  from calls c
  where c.parent_id = any(p_parent_ids)
    and (
      -- A dial was attempted. Survives any later status rewrite.
      c.called_at is not null
      -- Or it is in flight right now, before called_at has been written.
      or c.status in ('scheduled', 'in_progress')
    );
$$;

revoke all on function public.parents_with_calls(uuid[]) from public, anon, authenticated;
grant execute on function public.parents_with_calls(uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Resuming from a pause re-armed the missed-check-in alert burst.
--
-- The scheduler suppresses "too late" alerts for slots before max(paused_until,
-- created_at). But the Resume button clears paused_until to null rather than moving it, so
-- after an explicit resume that expression collapsed to created_at and every slot that had
-- already elapsed that day fired its own "their 9:00am check-in was missed" text. The fix
-- only ever worked for a pause that expired on its own.
alter table parents add column if not exists resumed_at timestamptz;

comment on column parents.resumed_at is
  'When check-ins were last explicitly resumed. Slots before this are not reported as missed — the caregiver was not being covered then.';

-- ---------------------------------------------------------------------------
-- 3. Changing the parent's phone number kept the old consent.
--
-- That fix lives in 0026, which owns save_parent_setup. It was originally written here and
-- referenced a type that does not exist ((c ->> 'role')::family_role; the column is plain
-- text). Run as a single batch — which is what both the Supabase SQL editor and the CLI do
-- — that one bad statement rolled back this entire file, silently taking the two fixes
-- above with it. They are the fixes that stop the scheduler cold-calling people who never
-- consented, so losing them quietly is far worse than the error itself.
--
-- Kept split deliberately: a migration that changes a security-gate definition should not
-- share a transaction with an unrelated 90-line function rewrite.
