-- Explicit SMS opt-in confirmation, required per family contact, so the caregiver
-- affirmatively attests consent was obtained rather than the app silently assuming it
-- (needed for Twilio toll-free verification's "Web Form" opt-in type, error 30511 —
-- entering someone's number is not itself proof of their consent to be texted).
alter table family_contacts
  add column sms_opt_in_confirmed boolean not null default false;
