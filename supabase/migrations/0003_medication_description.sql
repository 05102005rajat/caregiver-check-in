-- Lets a caregiver describe a medication by appearance/taste/location (e.g. "small blue
-- tablet, bitter, the one in the left drawer") for a parent who may not know drug names
-- but recognizes what a pill looks or tastes like. Read back to them via {{meds_due}}.
alter table medications
  add column description text;
