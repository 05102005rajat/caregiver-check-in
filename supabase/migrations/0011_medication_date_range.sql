-- Optional start/end date for a medication course (e.g. a 7-day antibiotic) instead of
-- only supporting indefinitely-repeating daily meds. Both null (the existing behavior)
-- means "every day, no end".
alter table medications
  add column start_date date,
  add column end_date date,
  add constraint medications_date_range_valid check (start_date is null or end_date is null or end_date >= start_date);
