-- Delivery status, separate from send status.
--
-- `status` today means "the provider accepted our API request", and the dashboard
-- presents that to the caregiver as "Alerted Rajat". Those are not the same claim. Right
-- now every SMS is accepted by Twilio and then reported undelivered (error 30032, the
-- toll-free number is still in verification) — so the product has been telling the
-- caregiver their family was notified while no message ever arrived.
--
-- For a system whose entire job is making sure someone is told, "we handed it to a
-- vendor" is not good enough to show as success.
alter table messages
  add column delivery_status text check (
    delivery_status is null or delivery_status in ('queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed')
  ),
  add column delivered_at timestamptz,
  -- Carrier/provider error code, e.g. Twilio 30032 (unverified toll-free number).
  add column delivery_error text;

-- Status callbacks arrive keyed by the provider's message id.
create index if not exists messages_twilio_sid_idx on messages (twilio_sid);
