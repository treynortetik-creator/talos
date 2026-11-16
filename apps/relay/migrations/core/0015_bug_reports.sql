-- In-app bug reports. One row per report a paired device sent; the report (JSON) and the picture are two encrypted files
-- under DATA_DIR/bug-reports/, named by the report id. The sweeper deletes both and the row 90 days after `created_at`.
create table core_bug_reports (
  report_id text primary key,           -- the ULID the device signed
  device_id text not null,              -- d_...
  created_at integer not null,          -- ms, the relay's clock
  image_type text not null,             -- image/png | image/jpeg
  image_bytes integer not null,
  json_bytes integer not null
);
create index core_bug_reports_created on core_bug_reports (created_at);
