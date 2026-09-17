-- Notification de-duplication.
--
-- Nothing currently stops the same family member being told the same thing twice in a
-- day: a retried call, two medication slots close together, or a concern that resurfaces
-- on a later call the same day all produce independent alerts. For a care product that
-- is worse than it sounds — the moment alerts feel like noise, people stop reading them,
-- and then the one that actually matters gets ignored too.
--
-- parent_id is denormalized (messages only reached it via call_id -> calls) so the
-- "have we already said this recently?" lookup is a single indexed query, and so the
-- check still works for alerts not tied to a completed call.
alter table messages
  add column parent_id uuid references parents(id) on delete cascade,
  add column fingerprint text;

-- Backfill so existing rows participate in de-duplication rather than looking like
-- "never alerted about anything".
update messages m
set parent_id = c.parent_id
from calls c
where m.call_id = c.id and m.parent_id is null;

create index messages_dedupe_idx on messages (parent_id, fingerprint, sent_at desc);
