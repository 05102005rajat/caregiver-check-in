-- A durable record that a dial was attempted, written BEFORE the dial.
--
-- The consent gate needs one fact: has this parent already been rung? Every signal it
-- could read — status, called_at, vapi_call_id — is written by the single post-dial update
-- in lib/dial.ts, and a row stranded at 'scheduled' is stranded *precisely because* that
-- update failed. So all three are absent in exactly the case the gate most needs to know
-- about, and the bug has now recurred three times in a row through different columns:
--
--   0024: gate keyed on status <> 'failed'  -> close-out set 'failed', erasing it
--   0025: gate keyed on called_at           -> close-out could not stamp it honestly
--   0026-era: stamp called_at only when vapi_call_id proves the dial  -> vapi_call_id is
--             written by the same failed update, so that guard is dead code and the
--             close-out erases the evidence again
--
-- Every one of those fixes read a value written *after* the risky operation. This column
-- is written *before* it, so nothing that fails afterwards can remove it. It also lets
-- called_at keep its honest meaning ("the call was placed"), which the dashboard renders,
-- rather than being overloaded with a value that is sometimes a guess.
alter table calls add column if not exists dial_attempted_at timestamptz;

comment on column calls.dial_attempted_at is
  'Stamped immediately before the Vapi call is placed, so a failure during or after dialing cannot erase the fact that we rang. The consent gate reads this; called_at means the call was actually placed.';

-- Backfill. called_at is the best evidence for historical rows; anything still active was
-- created by scheduleAndDial and had a dial attempted. Rows that are 'failed' with no
-- called_at are the "too late to call" placeholders, which never dialled — they stay null,
-- which is correct.
update calls set dial_attempted_at = called_at where called_at is not null and dial_attempted_at is null;
update calls set dial_attempted_at = created_at where status in ('scheduled', 'in_progress') and dial_attempted_at is null;

create index if not exists calls_dial_attempted_idx on calls (parent_id) where dial_attempted_at is not null;

-- Gate reads the pre-dial stamp.
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
      -- We rang them, whatever happened afterwards.
      c.dial_attempted_at is not null
      -- Belt and braces for rows predating this column, and for the window between the
      -- row being created and the pre-dial stamp landing.
      or c.called_at is not null
      or c.status in ('scheduled', 'in_progress')
    );
$$;

revoke all on function public.parents_with_calls(uuid[]) from public, anon, authenticated;
grant execute on function public.parents_with_calls(uuid[]) to service_role;
