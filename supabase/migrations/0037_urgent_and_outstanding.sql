-- Two facts a call now produces that nothing could store.
--
-- 1. `urgent` — the extractor's "this may need help right now" flag, which decides whether
--    the family gets "URGENT — please call her now" or "needs a look". It was computed,
--    texted, and thrown away. lib/insights.ts's needsAttention() rebuilds the same decision
--    for the dashboard from the stored columns, so with urgent unstored a call could text
--    the family an emergency and render on the dashboard as unflagged — "an alarming text
--    and a page telling them everything is fine", which is verbatim the drift HANDOVER's
--    invariant 3 exists to prevent, arriving through a new column instead of a new copy of
--    the rule.
--
-- 2. `outstanding_meds` — doses carried forward from an earlier call today, which Rosie is
--    told to ask about. The webhook validates every medication name the model returns
--    against `scheduled_meds`, and that snapshot holds THIS slot's medications only. So
--    when someone finally said "yes, I took the Lisinopril" on the evening call, the name
--    failed the check, the confirmation was discarded, and the same dose was raised again on
--    every later call for the rest of the day. The feature could ask but could never hear
--    the answer.

alter table calls add column if not exists urgent boolean not null default false;
alter table calls add column if not exists outstanding_meds text[] not null default '{}';

comment on column calls.urgent is
  'Extractor flag: this call may need help right now. Read by needsAttention so the dashboard and the SMS cannot disagree.';
comment on column calls.outstanding_meds is
  'Doses carried into this call from earlier today. Accepted alongside scheduled_meds when validating medication names the model returns.';
