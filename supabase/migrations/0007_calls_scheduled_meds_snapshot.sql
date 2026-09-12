-- Historical calls were being interpreted against whatever medications currently exist
-- (via medsAtLocalTime, matching the call's scheduled_for against *current* medication
-- rows) rather than what was actually configured when the call happened. If a caregiver
-- edits medications after a call, the old call's meaning could silently shift. Snapshot
-- the medication names actually due for this call at creation time instead.
alter table calls
  add column scheduled_meds text[];
