-- Backup alert channel: SMS delivery is blocked pending Twilio toll-free verification, so
-- family contacts can optionally also get alerts by email, which has no carrier compliance
-- gate at all.
alter table family_contacts
  add column email text;

alter table messages
  add column channel text not null default 'sms' check (channel in ('sms', 'email'));
