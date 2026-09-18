-- Deletion in one transaction.
--
-- 0013 made *saving* atomic because partial failure left inconsistent state. Deletion —
-- the operation whose entire promise to the user is "nothing is left" — was still eight
-- sequential statements plus a hand-rolled orphan pre-sweep, any of which could fail
-- halfway and leave the household partly removed after the UI said it was gone. The far
-- less dangerous path got the transaction; this one did not.
--
-- It also never touched sms_opt_ins, so "delete everything" left a permanent record of the
-- phone numbers involved, unmentioned anywhere in the UI.

drop function if exists public.delete_parent_household(uuid, uuid);

create function public.delete_parent_household(p_caregiver_id uuid, p_parent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phones text[];
  v_residue int;
begin
  -- Ownership is re-checked here rather than trusted from the caller. This is SECURITY
  -- DEFINER, so a caller who could reach it with someone else's parent id would otherwise
  -- delete that household outright — the same shape as the hole 0018 closed.
  if not exists (select 1 from parents where id = p_parent_id and caregiver_id = p_caregiver_id) then
    raise exception 'parent % does not belong to caregiver %', p_parent_id, p_caregiver_id;
  end if;

  -- Numbers this household knows about, before the rows go.
  select array_agg(distinct phone) into v_phones
  from (
    select phone from family_contacts where parent_id = p_parent_id
    union
    select phone from parents where id = p_parent_id
    union
    select phone from caregivers where id = p_caregiver_id
  ) all_phones
  where phone is not null;

  -- messages.parent_id arrived in 0015 and was backfilled only where call_id matched, and
  -- messages.call_id has no ON DELETE rule — so a row with a null parent_id survives a
  -- parent_id-scoped delete and then breaks the calls delete with an FK violation.
  delete from messages where call_id in (select id from calls where parent_id = p_parent_id);
  delete from messages where parent_id = p_parent_id;
  delete from calls where parent_id = p_parent_id;
  delete from medications where parent_id = p_parent_id;
  delete from appointments where parent_id = p_parent_id;
  delete from family_contacts where parent_id = p_parent_id;
  delete from watch_items where parent_id = p_parent_id;
  delete from escalation_rules where parent_id = p_parent_id;
  delete from parents where id = p_parent_id;

  -- sms_opt_ins is the one thing deliberately NOT fully deleted, and the UI says so.
  -- A row carrying revoked_at is a carrier-confirmed opt-out: dropping it would let this
  -- number be texted again by a future household, which is both a compliance violation and
  -- precisely the outcome the person asked to avoid. So an opt-out is kept as a tombstone
  -- with the identifying fields stripped; anything else is removed outright.
  if v_phones is not null then
    update sms_opt_ins
       set name = null, email = null, consent_text = null, consent_version = null,
           consented_at = null, terms_accepted_at = null
     where phone = any(v_phones) and revoked_at is not null;

    delete from sms_opt_ins where phone = any(v_phones) and revoked_at is null;
  end if;

  -- The caregiver's own row goes too: it holds their name, phone and email, and leaving it
  -- behind after "delete everything" is exactly the sort of quiet retention this function
  -- exists to stop. Their auth account survives, so they can start again.
  delete from caregivers where id = p_caregiver_id;

  -- Verified inside the transaction. The route used to check residue after the fact, which
  -- could only report a problem it was already too late to undo.
  select count(*) into v_residue from (
    select 1 from calls where parent_id = p_parent_id
    union all select 1 from messages where parent_id = p_parent_id
    union all select 1 from medications where parent_id = p_parent_id
    union all select 1 from appointments where parent_id = p_parent_id
    union all select 1 from family_contacts where parent_id = p_parent_id
    union all select 1 from watch_items where parent_id = p_parent_id
    union all select 1 from escalation_rules where parent_id = p_parent_id
    union all select 1 from parents where id = p_parent_id
  ) leftovers;

  if v_residue > 0 then
    raise exception 'deletion left % rows behind; rolled back', v_residue;
  end if;

  return jsonb_build_object('deleted', true, 'phones_considered', coalesce(array_length(v_phones, 1), 0));
end;
$$;

-- Service role only, same as every other definer function here.
revoke all on function public.delete_parent_household(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_parent_household(uuid, uuid) to service_role;
