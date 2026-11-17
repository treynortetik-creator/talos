-- `bridge_consumed_at`: when the owner's Mac answered `consumed` for this report (it is filed on disk there; ms, the relay's
-- clock). `bridge_queued_at` only says the report was queued once, and a queue entry can expire or be swept; this says it
-- arrived. The reconcile (core/bug-reports.ts `backfillOwnReports`) queues again every report with no `consumed` and no live
-- queue entry. Null for every report stored before this column: the reconcile sends it once more and the Mac, which has seen
-- its id or holds its problem, answers `consumed` at once.
alter table core_bug_reports add column bridge_consumed_at integer;
