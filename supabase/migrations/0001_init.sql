-- Caregiver Check-In Agent: initial schema (spec section 3)

create table caregivers (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text not null,
  phone text not null,
  created_at timestamptz default now()
);

create table parents (
  id uuid primary key default gen_random_uuid(),
  caregiver_id uuid references caregivers(id) on delete cascade,
  name text not null,
  phone text not null,
  timezone text not null default 'America/Los_Angeles',
  preferred_voice text default 'rosie',
  consent_given_at timestamptz,
  created_at timestamptz default now()
);

create table medications (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references parents(id) on delete cascade,
  name text not null,
  dose text,
  time_of_day time not null,
  notes text,
  active boolean default true
);

create table appointments (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references parents(id) on delete cascade,
  title text not null,
  starts_at timestamptz not null,
  location text,
  notes text
);

create table family_contacts (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references parents(id) on delete cascade,
  name text not null,
  phone text not null,
  role text,
  notify_on_miss boolean default true,
  notify_on_concern boolean default true
);

create table escalation_rules (
  parent_id uuid primary key references parents(id) on delete cascade,
  retry_after_minutes int default 30,
  max_retries int default 2,
  concern_keywords text[] default array['fall','fell','dizzy','pain','chest','breath','confused','scared']
);

create table calls (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references parents(id) on delete cascade,
  scheduled_for timestamptz not null,
  called_at timestamptz,
  status text, -- 'scheduled','in_progress','completed','no_answer','failed'
  vapi_call_id text,
  transcript text,
  summary text,
  meds_confirmed jsonb,
  concerns text[],
  created_at timestamptz default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls(id),
  contact_id uuid references family_contacts(id),
  body text not null,
  sent_at timestamptz default now(),
  twilio_sid text
);

-- Row-Level Security: a caregiver can only read/write rows tied to their own caregiver_id.
-- `caregivers.id` is the same value as `auth.uid()` for the logged-in user (see app/api/parents/route.ts,
-- which creates the caregiver row with id = auth.uid() on first save).

alter table caregivers enable row level security;
alter table parents enable row level security;
alter table medications enable row level security;
alter table appointments enable row level security;
alter table family_contacts enable row level security;
alter table escalation_rules enable row level security;
alter table calls enable row level security;
alter table messages enable row level security;

create policy "caregivers can manage their own row"
  on caregivers for all
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "caregivers can manage their own parents"
  on parents for all
  using (caregiver_id = auth.uid())
  with check (caregiver_id = auth.uid());

create policy "caregivers can manage their parents' medications"
  on medications for all
  using (parent_id in (select id from parents where caregiver_id = auth.uid()))
  with check (parent_id in (select id from parents where caregiver_id = auth.uid()));

create policy "caregivers can manage their parents' appointments"
  on appointments for all
  using (parent_id in (select id from parents where caregiver_id = auth.uid()))
  with check (parent_id in (select id from parents where caregiver_id = auth.uid()));

create policy "caregivers can manage their parents' family contacts"
  on family_contacts for all
  using (parent_id in (select id from parents where caregiver_id = auth.uid()))
  with check (parent_id in (select id from parents where caregiver_id = auth.uid()));

create policy "caregivers can manage their parents' escalation rules"
  on escalation_rules for all
  using (parent_id in (select id from parents where caregiver_id = auth.uid()))
  with check (parent_id in (select id from parents where caregiver_id = auth.uid()));

create policy "caregivers can read their parents' calls"
  on calls for select
  using (parent_id in (select id from parents where caregiver_id = auth.uid()));

create policy "caregivers can read their parents' messages"
  on messages for select
  using (
    call_id in (
      select c.id from calls c
      join parents p on p.id = c.parent_id
      where p.caregiver_id = auth.uid()
    )
  );
