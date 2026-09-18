-- Pre-warming the first call.
--
-- The single biggest determinant of whether a household ever gets off the ground is not
-- the wording of the consent line — it is whether the parent is expecting the call at all.
-- Until now the first contact was, unavoidably, a cold call: an unfamiliar synthetic voice
-- rings an older adult, says a family member's name, and asks permission to keep a record.
-- That is indistinguishable in form from the scam calls this exact demographic is trained
-- to hang up on, and no amount of rewording fixes it. Services doing this well have the
-- family member speak to their parent first and only then start the calls.
--
-- Two columns, because they answer different questions:
--   prewarm_confirmed_at — the caregiver states they have told their parent to expect it.
--   first_call_after     — don't ring before this instant, so the caregiver can line the
--                          first call up with a time their parent will be ready for it.
alter table parents add column if not exists prewarm_confirmed_at timestamptz;
alter table parents add column if not exists first_call_after timestamptz;

comment on column parents.prewarm_confirmed_at is
  'When the caregiver confirmed they had told their parent to expect the calls. Advisory: recorded and surfaced, never used to assert consent on the parent''s behalf.';
comment on column parents.first_call_after is
  'The scheduler places no call before this instant. Lets a caregiver schedule the very first call for a moment their parent is prepared for.';
