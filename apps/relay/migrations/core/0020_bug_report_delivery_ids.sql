-- `bridge_frame_id`: the frame the report was last queued as (its delivery id, or the new id of a requeue). The Mac's `consumed`
-- for it marks the report filed, and a live queue entry under it keeps the reconcile from queueing the report again.
-- `bridge_problem_id`: the problem id it was queued under, a random id made when it was first queued and known only to this
-- relay: a problem a device posts can never share it. Null for a report queued before these columns: the Mac knows that one
-- by the report id.
alter table core_bug_reports add column bridge_frame_id text;
alter table core_bug_reports add column bridge_problem_id text;
create index core_bug_reports_frame on core_bug_reports (bridge_frame_id);
