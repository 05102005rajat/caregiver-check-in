-- Separate "the scheduler ran" from "the scheduler ran and everything worked".
--
-- 0033's queue made one row do both jobs. `cron_heartbeat.last_tick_at` is the alarm
-- /api/health reads, and the tick deliberately withholds it when any household's queue work
-- failed — a scheduler that places zero calls while reporting success is the worst-shaped
-- failure this product has, so making it look dead is correct.
--
-- But lib/slots.ts then started reading the same column for a completely different
-- question. `neverOurs` asks "were we running when that slot lapsed", to tell a real missed
-- check-in from a caregiver adding a 09:00 medication at 14:00. With one column, a single
-- household stuck on a persistent fault freezes last_tick_at for EVERY household, so
-- neverOurs concludes the scheduler was down for all of them and every mid-day edit
-- manufactures a "their 9:00am check-in was missed" text.
--
-- One column, two meanings — the defect 0032 and 0027 were both written for. So: this one
-- is stamped on every tick that ran at all, regardless of outcome, and nothing reads it as
-- a health signal. last_tick_at keeps its meaning and keeps being the alarm.

alter table cron_heartbeat add column if not exists last_attempted_at timestamptz;

comment on column cron_heartbeat.last_attempted_at is
  'When a tick last ran, successful or not. Used by lib/slots.ts to tell "we were down" from "this slot was added after the fact". Never a health signal — /api/health reads last_tick_at.';

-- Backfill so the first tick after this migration does not read as "the scheduler has never
-- run" and re-report a day of slots that were only just added.
update cron_heartbeat set last_attempted_at = last_tick_at where last_attempted_at is null;
