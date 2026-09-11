-- calls.status was free-form text relying on a comment for valid values. A CHECK
-- constraint catches typos/bugs at the database level instead of silently accepting
-- an unrecognized status that the app's code would never actually query for.
alter table calls
  add constraint calls_status_check check (
    status is null or status in ('scheduled', 'in_progress', 'completed', 'no_answer', 'failed')
  );
