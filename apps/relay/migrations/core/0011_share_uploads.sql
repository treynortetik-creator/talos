-- Bytes a share token uploaded, so shares get their own daily budget and do not eat the owner's 200 MiB/day of
-- `POST /api/media` (docs/V2-FEATURES.md V4.5). The media itself lives in core_media like any upload.
create table core_share_uploads (
  media_id text primary key,
  size integer not null,
  created_at integer not null
);
create index core_share_uploads_at on core_share_uploads (created_at);
