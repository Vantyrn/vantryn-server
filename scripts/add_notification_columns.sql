-- Notification inbox: give notification_logs the two columns an inbox needs.
--
-- Additive and idempotent on purpose. Run this with psql/Neon SQL editor rather
-- than `prisma db push`: three divergent schemas point at this one database, and
-- a push diffs the WHOLE schema — the Admin schema did not even declare
-- NotificationLog, so a push from there would have dropped this table.
--
-- Safe to run repeatedly. The table had 0 rows when these were added, so there is
-- no backfill and nothing to migrate.

ALTER TABLE vendor_delivery.notification_logs
  ADD COLUMN IF NOT EXISTS type varchar(50),
  ADD COLUMN IF NOT EXISTS data jsonb;

-- The inbox lists newest-first per user; `status` doubles as the read flag
-- ('sent' | 'read') so no extra column is needed.
CREATE INDEX IF NOT EXISTS notification_logs_user_sent_idx
  ON vendor_delivery.notification_logs (user_id, sent_at DESC);
