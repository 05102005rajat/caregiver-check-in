-- Three related fixes to the setup-save path.
--
-- 1. messages.contact_id had a plain FK with no ON DELETE rule, so deleting a family
--    contact that had ever been notified failed with a foreign key violation. The
--    setup route swallowed that error, leaving the old contact row in place AND
--    inserting a duplicate — meaning that person received every subsequent alert twice.
-- 2. Message history should survive a contact being removed, so the recipient address
--    is now denormalized onto the row rather than only reachable via the FK.
-- 3. The whole setup save is now one Postgres transaction instead of ~8 sequential
--    round trips that could fail partway through and leave inconsistent state.

alter table messages add column recipient text;

do $$
declare
  v_constraint text;
begin
  select conname into v_constraint
  from pg_constraint
  where conrelid = 'messages'::regclass
    and contype = 'f'
    and conkey = array[(select attnum from pg_attribute where attrelid = 'messages'::regclass and attname = 'contact_id')];

  if v_constraint is not null then
    execute format('alter table messages drop constraint %I', v_constraint);
  end if;
end $$;

alter table messages
  add constraint messages_contact_id_fkey
  foreign key (contact_id) references family_contacts(id) on delete set null;

-- Runs as one transaction: any exception rolls back every write below, so a partial
-- failure can never leave a parent with (say) new medications but stale contacts.
create or replace function save_parent_setup(
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
  p_max_retries int
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

  -- One parent per caregiver (v1): resubmitting updates that same parent rather than
  -- creating a second one with duplicate scheduled calls.
  insert into parents (caregiver_id, name, phone, timezone, preferred_voice)
  values (p_caregiver_id, p_parent_name, p_parent_phone, p_parent_timezone, p_assistant_name)
  on conflict (caregiver_id) do update
    set name = excluded.name,
        phone = excluded.phone,
        timezone = excluded.timezone,
        preferred_voice = excluded.preferred_voice
  returning id into v_parent_id;

  -- Safe to delete first now that we're inside a transaction — a later failure rolls
  -- these back. messages.contact_id is ON DELETE SET NULL, so notification history
  -- survives (with its denormalized recipient) even when a contact is removed.
  delete from medications where parent_id = v_parent_id;
  delete from appointments where parent_id = v_parent_id;
  delete from family_contacts where parent_id = v_parent_id;

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

  insert into escalation_rules (parent_id, retry_after_minutes, max_retries)
  values (v_parent_id, p_retry_after_minutes, p_max_retries)
  on conflict (parent_id) do update
    set retry_after_minutes = excluded.retry_after_minutes,
        max_retries = excluded.max_retries;

  return v_parent_id;
end;
$$;

-- Only ever invoked by the service-role client from /api/parents, which derives the
-- caregiver id from the authenticated session rather than trusting the request body.
revoke execute on function save_parent_setup from anon, authenticated;
