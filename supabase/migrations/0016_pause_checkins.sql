-- Pause check-ins.
--
-- Without this the only way to stop calls is to delete the medications, which destroys
-- the schedule you'd have to rebuild afterwards. Meanwhile the realistic week-one
-- scenarios are unavoidable: the parent is in hospital, travelling, has family staying,
-- or the caregiver is with them in person. In every one of those cases the current
-- behaviour is actively bad — Rosie keeps calling a parent who can't answer, and the
-- family gets a "didn't answer" alert every single day for something they already know.
alter table parents
  add column paused_until timestamptz;

comment on column parents.paused_until is
  'Scheduler skips this parent until this instant. Null means active. Past values are harmless, so "resume" just clears it.';
