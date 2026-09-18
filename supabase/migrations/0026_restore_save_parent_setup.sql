-- Repairs save_parent_setup, which 0025 broke.
--
-- 0025 rewrote this function in order to make one change (clear consent when the parent's
-- phone number changes) but reconstructed the body from a partial reading of 0017 rather
-- than copying it. Six differences crept in:
--
--   * `(c ->> 'role')::family_role` — there is no family_role type. This is the one that
--     threw ("type family_role does not exist"), taking the whole setup form down.
--   * four missing `nullif(..., '')` wrappers on dose, notes, location and appointment
--     notes, which would have stored empty strings where the app expects NULL.
--   * missing `coalesce(..., '[]'::jsonb)` on every array argument, so a null array would
--     have raised instead of being treated as empty.
--
-- Only the first failed loudly; the rest would have been silent data corruption. The body
-- below is 0017's verbatim, with the consent reset as the sole intentional change.

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
        -- THE ONLY INTENTIONAL CHANGE (see 0025's rationale): consent belongs to the person
        -- on the end of the line, not to the row. If the number changes, the consent we
        -- hold is for a number we no longer call, so it is cleared and Rosie asks again.
        -- A refusal clears with it — the new number never refused anything.
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
         nullif(m ->> 'dose', ''),
         (m ->> 'time_of_day')::time,
         nullif(m ->> 'notes', ''),
         nullif(m ->> 'description', ''),
         nullif(m ->> 'start_date', '')::date,
         nullif(m ->> 'end_date', '')::date
  from jsonb_array_elements(coalesce(p_medications, '[]'::jsonb)) as m;

  insert into appointments (parent_id, title, starts_at, location, notes)
  select v_parent_id,
         a ->> 'title',
         (a ->> 'starts_at')::timestamptz,
         nullif(a ->> 'location', ''),
         nullif(a ->> 'notes', '')
  from jsonb_array_elements(coalesce(p_appointments, '[]'::jsonb)) as a;

  insert into family_contacts (parent_id, name, phone, email, role, notify_on_miss, notify_on_concern, sms_opt_in_confirmed)
  select v_parent_id,
         c ->> 'name',
         c ->> 'phone',
         nullif(c ->> 'email', ''),
         c ->> 'role',
         (c ->> 'notify_on_miss')::boolean,
         (c ->> 'notify_on_concern')::boolean,
         (c ->> 'sms_opt_in_confirmed')::boolean
  from jsonb_array_elements(coalesce(p_family_contacts, '[]'::jsonb)) as c;

  insert into watch_items (parent_id, description, always_alert)
  select v_parent_id,
         w ->> 'description',
         coalesce((w ->> 'always_alert')::boolean, false)
  from jsonb_array_elements(coalesce(p_watch_items, '[]'::jsonb)) as w;

  insert into escalation_rules (parent_id, retry_after_minutes, max_retries)
  values (v_parent_id, p_retry_after_minutes, p_max_retries)
  on conflict (parent_id) do update
    set retry_after_minutes = excluded.retry_after_minutes,
        max_retries = excluded.max_retries;

  return v_parent_id;
end;
$$;

-- Re-apply 0018's lockdown. Every `drop function` + `create` re-applies Postgres's default
-- EXECUTE grant to PUBLIC, which anon and authenticated inherit — that is the exact hole
-- 0018 was written to close, and it re-opens on every redefinition of this function.
revoke execute on function save_parent_setup(
  uuid, text, text, text, text, text, text, text, jsonb, jsonb, jsonb, int, int, jsonb
) from public, anon, authenticated;
