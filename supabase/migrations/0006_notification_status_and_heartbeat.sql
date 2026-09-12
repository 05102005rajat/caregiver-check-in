-- Makes an SMS failure durable/visible instead of only a server log line — a caregiver
-- (or anyone inspecting the data) can see that a notification never actually went out.
alter table messages
  add column status text not null default 'sent' check (status in ('sent', 'failed')),
  add column error text;

-- Single-row heartbeat: /api/cron/tick updates last_tick_at on every successful run.
-- /api/health reports unhealthy if it's gone stale, so an external monitor pointed at
-- that endpoint can alert if the scheduler silently stops running.
create table cron_heartbeat (
  id boolean primary key default true,
  last_tick_at timestamptz,
  constraint cron_heartbeat_single_row check (id)
);
insert into cron_heartbeat (id, last_tick_at) values (true, null);

-- Only ever read/written by the service-role admin client (which bypasses RLS
-- regardless), so this has no policies — it just blocks direct anon/authenticated access.
alter table cron_heartbeat enable row level security;
