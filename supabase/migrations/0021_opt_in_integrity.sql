-- Fixes to the opt-in record so it can actually be used as evidence and as an opt-out list.
--
-- 1. Phone numbers are stored E.164-normalized, and one row per number. Without a unique
--    key, re-submitting the form (an unchecked submission, then a return visit; or a
--    double-click) produced several rows for the same person with no way to tell which
--    reflects their current wishes — ambiguous in exactly the dispute this table exists
--    to settle.
-- 2. The wording is now recorded as a version rather than free text supplied by the
--    caller, and whether they accepted terms/privacy is recorded rather than discarded.
alter table sms_opt_ins
  add column if not exists consent_version text,
  add column if not exists terms_accepted_at timestamptz;

-- Collapse any pre-existing duplicates before the unique index (keeps the most recent).
delete from sms_opt_ins a
using sms_opt_ins b
where a.phone = b.phone and a.created_at < b.created_at;

create unique index if not exists sms_opt_ins_phone_key on sms_opt_ins (phone);
