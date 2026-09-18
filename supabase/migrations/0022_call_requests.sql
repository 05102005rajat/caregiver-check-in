-- What the person actually asked for.
--
-- Rosie explicitly tells people "I'll let your family know about that" when they mention
-- wanting something — a food they're craving, a chore, someone to visit. Until now there
-- was nowhere to put it, so those promises were silently broken: the person heard her
-- agree to pass it on, and the family never heard it.
--
-- Deliberately separate from `concerns`. Wanting pizza is not a health concern and must
-- not escalate an otherwise-fine check-in into an alert, but it is exactly the kind of
-- small human thing a family wants relayed.
alter table calls
  add column if not exists requests text[];
