-- 1. The messages policy hides rows from the family they were sent about.
--
-- 0001 scoped reads on messages through call_id. 0015 then added messages.parent_id — and
-- every alert written since carries it — but the policy was never widened, so a caregiver
-- can only see an alert if it also happens to join cleanly through calls. The dashboard
-- reads messages to answer "was my family actually told?", which is the question the whole
-- delivery-status feature exists to answer, and the rows backing it were unreadable.
drop policy if exists "caregivers can read their parents' messages" on messages;

create policy "caregivers can read their parents' messages"
  on messages for select
  using (
    parent_id in (select p.id from parents p where p.caregiver_id = auth.uid())
    or call_id in (
      select c.id from calls c
      join parents p on p.id = c.parent_id
      where p.caregiver_id = auth.uid()
    )
  );

-- 2. cron_heartbeat was readable by every authenticated user.
--
-- The only cross-tenant read policy in a schema where everything else scopes through
-- parents.caregiver_id. It is one timestamp rather than personal data, so this is about
-- consistency rather than exposure — but "every signed-in user can read this table" is not
-- a sentence that should be true by accident anywhere in here, and the dashboard reads it
-- as an authenticated caregiver, so restricting it to caregivers who actually have a
-- household costs nothing.
drop policy if exists "authenticated can read heartbeat" on cron_heartbeat;

create policy "caregivers with a household can read heartbeat"
  on cron_heartbeat for select
  to authenticated
  using (exists (select 1 from parents p where p.caregiver_id = auth.uid()));

-- 3. Transcripts were retained forever.
--
-- Across 28 migrations there was no TTL, no age-based delete, no retention column — while
-- the privacy policy tells people consent can be withdrawn, which until now only ever
-- meant "prospectively". Someone who consented for six months and then withdrew kept every
-- prior transcript of their conversations about their own health.
--
-- The product's thesis is "what changed" (0014, lib/insights.ts), which runs on summary,
-- mood and concerns — not on raw transcripts. Dropping the transcript after 30 days costs
-- the product nothing and removes the most sensitive artifact it holds. 30 rather than 7
-- because the dashboard offers "View transcript" on recent calls and a caregiver who reads
-- a worrying alert a fortnight later should still be able to see what was said.
create index if not exists calls_transcript_retention_idx
  on calls (called_at)
  where transcript is not null;
