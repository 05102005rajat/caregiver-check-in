-- Two things the scheduler was getting wrong by reusing columns that mean something else.
--
-- 1. `called_at` means "the call was placed". The stale-scheduled reaper was writing it to
--    claim a row it was ABOUT to re-dial — on a call that, by definition, had never been
--    dialled successfully. That value is user-visible in three places: CallRow renders
--    "Called 9:03am", the dashboard header renders "Last check-in 9:03am", and
--    hasCoveredCallToday treats a non-null called_at as a connected call and suppresses
--    that day's appointment reminder. So a row stranded by a bookkeeping failure showed the
--    caregiver a check-in that never happened, and silently cancelled a reminder.
--
--    This is the same defect as retry_count being overloaded by two mechanisms (0027's
--    notes): one column, two meanings, and the quieter meaning wins in the UI. The reaper
--    gets its own column.
--
-- 2. calls_transcript_retention_idx was built on called_at, but the retention sweep filters
--    and orders by created_at — deliberately, because a call whose post-dial write failed
--    keeps called_at null and still receives a transcript from the webhook. The index
--    therefore could never be used by the query it was created for, and every tick
--    sequentially scanned `calls` to find expired transcripts.

alter table calls add column if not exists stale_redial_at timestamptz;

comment on column calls.stale_redial_at is
  'When the stale-scheduled reaper last re-attempted this row. Claim/attempt bookkeeping only — never means the call connected. Use called_at for that.';

drop index if exists calls_transcript_retention_idx;

create index if not exists calls_transcript_retention_idx
  on calls (created_at)
  where transcript is not null;
