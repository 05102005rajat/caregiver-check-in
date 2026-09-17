-- SECURITY: save_parent_setup was callable by anyone holding the anon key.
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default, and both `anon` and
-- `authenticated` inherit that. The REVOKE in 0013/0017 named those two roles
-- explicitly, which does nothing about the PUBLIC grant they inherit from — and every
-- `drop function` + `create` re-applies the default grant fresh.
--
-- The function is SECURITY DEFINER and takes p_caregiver_id as a *parameter* rather than
-- deriving it from auth.uid(), because the app calls it with the service-role key after
-- checking the session itself. Exposed over PostgREST that combination means anyone with
-- the anon key — which ships in the browser bundle, so effectively anyone at all — could
-- pass another household's caregiver id and overwrite that parent's row, including
-- parent_phone. That redirects every future check-in call to a number of their choosing,
-- and wipes the medications/contacts in the same transaction.
--
-- Verified exploitable against production with the public anon key before this fix.
revoke execute on function save_parent_setup(
  uuid, text, text, text, text, text, text, text, jsonb, jsonb, jsonb, int, int, jsonb
) from public, anon, authenticated;

-- Belt and braces: the service-role key bypasses grants entirely, so nothing the app
-- does depends on any role retaining EXECUTE here.
