-- Records that a parent actively declined the recording consent, as distinct from
-- "never answered the question yet". Both previously looked identical (consent_given_at
-- null), which had three consequences:
--
--   1. Rosie promises on refusal that she won't ring again. Nothing persisted the refusal,
--      so processRetries re-dialled an outstanding no-answer row the same day — breaking
--      that promise within minutes of making it.
--   2. The caregiver was never told. The scheduler just went quiet, and since this product
--      is built on "no news is good news", silence reads as everything working.
--   3. There was no record that a refusal had ever happened, which is exactly the record a
--      two-party-consent state expects you to be able to produce.
alter table parents add column if not exists consent_refused_at timestamptz;

comment on column parents.consent_refused_at is
  'Set when the parent explicitly declines recording consent on a call. Never dial again while this is set and consent_given_at is null.';
