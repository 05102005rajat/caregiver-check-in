-- Household deletion was reaching across tenant boundaries.
--
-- sms_opt_ins is keyed by phone alone (0021) with no household scoping, so 0028's cleanup
-- matched every row for the deleted household's numbers — regardless of who else is using
-- them. The obvious case is two adult children who each list the same sibling as a family
-- contact: one deletes their household, and the other household's consent record, including
-- the verbatim consent_text, is destroyed. That number keeps being texted with no evidence
-- we were ever allowed to, which is precisely the artifact 0020 exists to produce.
--
-- It also deleted the caregiver row unconditionally, which is correct for their own data
-- but means the same number surviving elsewhere loses its opt-in evidence with it.
--
-- Fix: only touch an opt-in row if no surviving household still references that number.

drop function if exists public.delete_parent_household(uuid, uuid);

create function public.delete_parent_household(p_caregiver_id uuid, p_parent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phones text[];
  v_orphaned text[];
  v_residue int;
begin
  if not exists (select 1 from parents where id = p_parent_id and caregiver_id = p_caregiver_id) then
    raise exception 'parent % does not belong to caregiver %', p_parent_id, p_caregiver_id;
  end if;

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
  delete from caregivers where id = p_caregiver_id;

  -- Now that this household's rows are gone, work out which of its numbers nobody else is
  -- still using. Anything another household references is left completely untouched — its
  -- consent record belongs to them, not to the household being deleted.
  if v_phones is not null then
    select array_agg(p) into v_orphaned
    from unnest(v_phones) as p
    where not exists (select 1 from family_contacts fc where fc.phone = p)
      and not exists (select 1 from parents pa where pa.phone = p)
      and not exists (select 1 from caregivers cg where cg.phone = p);

    if v_orphaned is not null then
      -- A carrier-confirmed opt-out is kept as a stripped tombstone: dropping it would let
      -- the number be texted again by a future household, which is both a compliance
      -- violation and exactly what the person asked to avoid.
      update sms_opt_ins
         set name = null, email = null, consent_text = null, consent_version = null,
             consented_at = null, terms_accepted_at = null
       where phone = any(v_orphaned) and revoked_at is not null;

      delete from sms_opt_ins where phone = any(v_orphaned) and revoked_at is null;
    end if;
  end if;

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

  return jsonb_build_object(
    'deleted', true,
    'phones_considered', coalesce(array_length(v_phones, 1), 0),
    'phones_orphaned', coalesce(array_length(v_orphaned, 1), 0)
  );
end;
$$;

revoke all on function public.delete_parent_household(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_parent_household(uuid, uuid) to service_role;
