-- Watch items: things the family already knows about.
--
-- Every older adult has ongoing complaints — a bad knee, poor sleep, a sore back. Today
-- each mention of one is treated like news, so the family gets told about their mother's
-- arthritis every single morning. That is the fastest way to train someone to ignore
-- alerts, which then makes them miss the one that matters.
--
-- A watch item says: "we know about this, ask after it, but only tell us if it changes."
-- It also gives Rosie something to follow up on by name, which is what makes a check-in
-- feel like a person remembering rather than a form being read out.
create table if not exists watch_items (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references parents(id) on delete cascade,
  -- Free text in the caregiver's own words, e.g. "left knee pain since her fall in June".
  description text not null,
  -- false: mention it in the summary but don't alert unless it sounds worse than usual.
  -- true: always alert when it comes up (for something being actively monitored).
  always_alert boolean not null default false,
  created_at timestamptz default now()
);

create index if not exists watch_items_parent_idx on watch_items (parent_id);

alter table watch_items enable row level security;

drop policy if exists "caregivers can manage their parents' watch items" on watch_items;
create policy "caregivers can manage their parents' watch items"
  on watch_items for all
  using (parent_id in (select id from parents where caregiver_id = auth.uid()))
  with check (parent_id in (select id from parents where caregiver_id = auth.uid()));

-- Extends the atomic setup save (0013) to cover watch items. Same transaction, same
-- replace-wholesale semantics as the other child tables.
--
-- Adding a parameter does NOT replace the previous function: Postgres treats a different
-- argument list as a separate overload, leaving two functions with this name. That both
-- makes an unqualified REVOKE ambiguous (error 42725) and leaves a stale 13-argument
-- version callable that would silently ignore watch items. Drop it explicitly by
-- signature first.
drop function if exists save_parent_setup(
  uuid, text, text, text, text, text, text, text, jsonb, jsonb, jsonb, int, int
);
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
        preferred_voice = excluded.preferred_voice
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

revoke execute on function save_parent_setup(
  uuid, text, text, text, text, text, text, text, jsonb, jsonb, jsonb, int, int, jsonb
) from anon, authenticated;
