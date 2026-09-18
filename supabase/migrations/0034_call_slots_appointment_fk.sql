-- call_slots.appointment_id must not cascade.
--
-- 0033 declared it `on delete cascade`, which reads as tidy and is wrong here, because
-- save_parent_setup deletes and re-inserts every appointment row on EVERY save (0026,
-- line 79 — the whole household is rewritten in one transaction). So an ordinary edit to a
-- medication at 14:00 silently deletes that day's appointment reminder slot, whatever state
-- it was in.
--
-- The damage is not just a lost row. A slot that had already expired and texted the family
-- "the appointment reminder didn't go out" is deleted, the next tick's materializeSlots
-- re-plans the same reminder as pending, and expireLapsedSlots expires it a second time and
-- sends the same alert again. The safety dedupe window is 4 hours, so any edit later in the
-- day re-sends an alarm about a day that was already reported.
--
-- `set null` is what was wanted, matching the deliberate choice made two lines below it for
-- call_id: the slot outlives the thing it points at, and med_names/kind already carry what
-- the call was for.

alter table call_slots
  drop constraint if exists call_slots_appointment_id_fkey;

alter table call_slots
  add constraint call_slots_appointment_id_fkey
  foreign key (appointment_id) references appointments(id) on delete set null;
