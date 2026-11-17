-- Reports are also queued to this relay's own bridge (core/bug-reports.ts `queueToBridge`). `bridge_queued_at` is when that
-- succeeded (ms, the relay's clock); null means not yet, and the startup backfill queues it.
alter table core_bug_reports add column bridge_queued_at integer;
