-- Usage log for the live-voice caps (spec 6.5). One row per call, written when the call starts (seconds = 0) and
-- finalised from `session.closed` usage. No transcript, no message text.
create table voice_usage (
  voice_session_id text primary key,
  started_at text not null,
  seconds integer not null default 0,
  -- Checkpointed every 30 s while a call is live; `open` = 1 until finalised, so a restart can close out orphans.
  last_seen_at text,
  open integer not null default 0
);
create index voice_usage_started_at on voice_usage (started_at);
