-- Lets the /dashboard page (rendered with the RLS-scoped session client) read the single
-- global heartbeat row directly, instead of needing the service-role admin client just to
-- show "scheduler last ran at ...". Read-only; only /api/cron/tick (service-role) writes it.
create policy "authenticated users can read the cron heartbeat"
  on cron_heartbeat for select
  using (auth.role() = 'authenticated');
