-- Claude already extracts a mood for every call, but it was only ever used for a
-- one-off "is this concerning?" boolean and then discarded. Persisting it is what makes
-- change-over-time analysis possible ("she's sounded low three days running"), which is
-- the actual product value — a caregiver wants to know what CHANGED, not to re-read a
-- transcript every morning.
alter table calls
  add column mood text check (mood is null or mood in ('good', 'okay', 'low', 'concerning', 'unknown'));
