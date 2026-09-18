-- "Has this parent ever been called?" — the input to the consent gate.
--
-- The scheduler was answering this by selecting every non-failed call row for every
-- household on each tick and building a Set of parent_ids from the result. PostgREST caps
-- response rows (Supabase defaults to 1000), and that cap is silent: once total call
-- history crosses it, rows fall outside the returned page, the parents they belong to read
-- as "never called", and consentBlocksNewCalls flips to false — resuming automatic
-- cold-calling of people who never consented. The gate would disable itself purely by the
-- product being used for long enough, with nothing in the logs to say so.
--
-- An aggregate answers it in one row per parent regardless of history size.

-- Dropped by explicit signature first: `create or replace` with a changed argument list
-- creates an overload rather than replacing, which then makes an unqualified REVOKE
-- ambiguous (42725) and rolls the whole migration back. That has bitten this repo before.
drop function if exists public.parents_with_calls(uuid[]);

create function public.parents_with_calls(p_parent_ids uuid[])
returns table (parent_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select distinct c.parent_id
  from calls c
  where c.parent_id = any(p_parent_ids)
    -- 'failed' is the one status meaning Vapi rejected the call and it never rang. Every
    -- other status — including 'scheduled', which can mean the call went out but our own
    -- bookkeeping write failed after — means a real call reached the parent.
    and c.status <> 'failed';
$$;

-- Service role only: this is scheduler infrastructure, never called from the browser, and
-- it reads across households by design.
revoke all on function public.parents_with_calls(uuid[]) from public, anon, authenticated;
grant execute on function public.parents_with_calls(uuid[]) to service_role;
