-- Record per household when we last successfully planned its day.
--
-- lib/slots.ts's `neverOurs` asks one question: "were we planning this household's day when
-- that slot lapsed?" It tells a real missed check-in ("the scheduler was down") from a
-- fabricated one ("the caregiver added a 09:00 dose at 14:00"). Only the first should text
-- the family.
--
-- It has been answered from the wrong column twice, and both times the mistake was the same
-- shape — a global signal standing in for a per-household fact:
--
--   last_tick_at       withheld whenever ANY household is degraded, so one broken household
--                      convinced the planner the scheduler had been down for everyone, and
--                      every mid-day edit manufactured a missed-check-in text. (0035)
--   last_attempted_at  stamped on every tick that ran at all — including ticks where
--                      materializeSlots refused to plan because the medications read had
--                      failed. A four-hour outage on that query then looked like four hours
--                      of successful planning, and the 09:00 dose it never queued was
--                      dropped in silence, which is the direction that actually matters.
--
-- Neither column is wrong; they answer questions about the SCHEDULER. This one answers a
-- question about a HOUSEHOLD, and is stamped only when that household's day was actually
-- planned. Deliberately left null for existing rows: null reads as "we don't know", and
-- `neverOurs` treats not knowing as grounds to report rather than to stay quiet.

alter table parents add column if not exists last_planned_at timestamptz;

comment on column parents.last_planned_at is
  'When materializeSlots last succeeded for this parent. Read by lib/slots.ts to tell a scheduler outage from a slot added after its own deadline. Not a health signal — see cron_heartbeat.';
