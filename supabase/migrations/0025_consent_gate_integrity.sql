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
-- 3. Changing the parent''s phone number kept the old consent.
--
-- save_parent_setup updated phone and left consent_given_at alone, so a corrected typo, a
-- new carrier, or an entirely different person inherited the previous consent: lib/dial.ts
-- then passed consent_already_given=true, Rosie skipped the consent question, and the
-- end-of-call webhook stored the transcript. That is recording a person who was never
-- asked, in a two-party-consent state.
drop function if exists save_parent_setup(
  uuid, text, text, text, text, text, text, text, jsonb, jsonb, jsonb, int, int, jsonb
);
create function save_parent_setup(
  p_caregiver_id uuid,
  p_caregiver_email text,
  p_caregiver_name text,
  p_caregiver_phone text,
  p_parent_name text,
  p_parent_phone text,
  p_parent_timezone text,
  p_assistant_name text,
  p_medications jsonb,
  p_appointments jsonb,
  p_family_contacts jsonb,
  p_retry_after_minutes int,
  p_max_retries int,
  p_watch_items jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent_id uuid;
begin
  insert into caregivers (id, email, name, phone)
  values (p_caregiver_id, p_caregiver_email, p_caregiver_name, p_caregiver_phone)
  on conflict (id) do update
    set email = excluded.email,
        name = excluded.name,
        phone = excluded.phone;

  insert into parents (caregiver_id, name, phone, timezone, preferred_voice)
  values (p_caregiver_id, p_parent_name, p_parent_phone, p_parent_timezone, p_assistant_name)
  on conflict (caregiver_id) do update
    set name = excluded.name,
        phone = excluded.phone,
        timezone = excluded.timezone,
        preferred_voice = excluded.preferred_voice,
        -- Consent belongs to the person on the end of the line, not to the row. If the
        -- number changes, the consent we hold is for a number we are no longer calling, so
        -- it is cleared and Rosie asks again on the next call. A refusal is cleared with
        -- it: the new number never refused anything.
        consent_given_at = case
          when parents.phone is distinct from excluded.phone then null
          else parents.consent_given_at
        end,
        consent_refused_at = case
          when parents.phone is distinct from excluded.phone then null
          else parents.consent_refused_at
        end
  returning id into v_parent_id;

  delete from medications where parent_id = v_parent_id;
  delete from appointments where parent_id = v_parent_id;
  delete from family_contacts where parent_id = v_parent_id;
  delete from watch_items where parent_id = v_parent_id;

  insert into medications (parent_id, name, dose, time_of_day, notes, description, start_date, end_date)
  select v_parent_id,
         m ->> 'name',
         m ->> 'dose',
         (m ->> 'time_of_day')::time,
         m ->> 'notes',
         nullif(m ->> 'description', ''),
         nullif(m ->> 'start_date', '')::date,
         nullif(m ->> 'end_date', '')::date
  from jsonb_array_elements(p_medications) as m;

  insert into appointments (parent_id, title, starts_at, location, notes)
  select v_parent_id,
         a ->> 'title',
         (a ->> 'starts_at')::timestamptz,
         a ->> 'location',
         a ->> 'notes'
  from jsonb_array_elements(p_appointments) as a;

  insert into family_contacts (parent_id, name, phone, email, role, notify_on_miss, notify_on_concern, sms_opt_in_confirmed)
  select v_parent_id,
         c ->> 'name',
         c ->> 'phone',
         nullif(c ->> 'email', ''),
         (c ->> 'role')::family_role,
         coalesce((c ->> 'notify_on_miss')::boolean, true),
         coalesce((c ->> 'notify_on_concern')::boolean, true),
         coalesce((c ->> 'sms_opt_in_confirmed')::boolean, false)
  from jsonb_array_elements(p_family_contacts) as c;

  insert into watch_items (parent_id, description, always_alert)
  select v_parent_id,
         w ->> 'description',
         coalesce((w ->> 'always_alert')::boolean, false)
  from jsonb_array_elements(p_watch_items) as w;

  insert into escalation_rules (parent_id, retry_after_minutes, max_retries)
  values (v_parent_id, p_retry_after_minutes, p_max_retries)
  on conflict (parent_id) do update
    set retry_after_minutes = excluded.retry_after_minutes,
        max_retries = excluded.max_retries;

  return v_parent_id;
end;
$$;

-- Same lockdown as 0018: callable only by the service role, never from the browser.
revoke all on function save_parent_setup(
  uuid, text, text, text, text, text, text, text, jsonb, jsonb, jsonb, int, int, jsonb
) from public, anon, authenticated;
grant execute on function save_parent_setup(
  uuid, text, text, text, text, text, text, text, jsonb, jsonb, jsonb, int, int, jsonb
) to service_role;
