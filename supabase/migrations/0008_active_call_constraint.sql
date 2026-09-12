-- Enforces "at most one active call per parent" atomically at the database level. This
-- closes a real race: the test-call route's old "check for a recent call, then insert"
-- pattern had a window where two near-simultaneous requests could both pass the check
-- and both place a real, paid Vapi call. An INSERT that violates this constraint fails
-- immediately (same 23505 error code already handled by scheduleAndDial's idempotency
-- check), so the guard is atomic instead of check-then-act.
create unique index calls_parent_active_unique on calls (parent_id)
  where status in ('scheduled', 'in_progress');
