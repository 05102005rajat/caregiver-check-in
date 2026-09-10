-- One parent per caregiver in v1 (spec section 10: "No multiple parents per caregiver").
-- Lets /api/parents upsert on caregiver_id instead of creating duplicate parent rows
-- (and duplicate real phone calls) if the setup form is submitted more than once.
alter table parents
  add constraint parents_caregiver_id_key unique (caregiver_id);

-- Tracks retry attempts per call slot so escalation_rules.max_retries is enforced
-- correctly (previously counted 'failed' rows across a parent's whole day, which
-- shared one retry budget across unrelated med times).
alter table calls
  add column retry_count int not null default 0;

-- One calls row per parent per scheduled instant: guards against a cron tick firing
-- a duplicate real phone call for the same slot (e.g. overlapping/duplicate invocations).
alter table calls
  add constraint calls_parent_scheduled_for_key unique (parent_id, scheduled_for);
