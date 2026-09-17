-- Public, self-service SMS opt-in.
--
-- Twilio rejected the toll-free verification three times because the opt-in "proof" was a
-- page describing a consent checkbox rather than a form a reviewer could actually use.
-- Their guidance (ticket 29597948) requires a real form: a phone field, an unchecked
-- consent box carrying the SMS-specific language, separate terms/privacy agreement, and
-- crucially the form must remain submittable WITHOUT consenting.
--
-- It also fixes a genuine weakness rather than only satisfying a reviewer. Until now the
-- only consent record was a caregiver ticking a box asserting their relative had agreed —
-- consent given on someone else's behalf. This records the family member's own action,
-- with the exact wording they agreed to, so "what did this person actually consent to,
-- and when" is answerable from the row itself rather than from whatever the page said
-- at the time.
create table if not exists sms_opt_ins (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  name text,
  email text,
  -- Null means they submitted the form without ticking consent, which is explicitly
  -- allowed. Keeping the row records that they asked to be contacted but did NOT agree
  -- to texts, which is exactly the distinction that matters in a compliance dispute.
  consented_at timestamptz,
  -- Verbatim copy of the wording shown, so a later edit to the page can't retroactively
  -- change what someone is recorded as having agreed to.
  consent_text text,
  revoked_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists sms_opt_ins_phone_idx on sms_opt_ins (phone);

-- Written only by the service-role client from the public form route, and never read by
-- caregivers — RLS on with no policies denies anon/authenticated access outright.
alter table sms_opt_ins enable row level security;
