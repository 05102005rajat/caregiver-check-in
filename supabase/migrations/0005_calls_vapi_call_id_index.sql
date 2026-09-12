-- app/api/vapi/webhook and the record_consent flow both look up a `calls` row by
-- vapi_call_id on every request; without an index this is a sequential scan that gets
-- more expensive (in Supabase compute/IO) as the table grows. A unique index also
-- enforces the data invariant (each real Vapi call maps to exactly one row) — Postgres
-- unique indexes permit any number of NULLs, so rows not yet dialed are unaffected.
create unique index calls_vapi_call_id_idx on calls (vapi_call_id);
