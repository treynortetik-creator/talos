-- Relay core: replay buffer, durable outbox to the bridge, dedup ids, cards, threads, statuses, media, push.
-- Message bodies, cards and media metadata that can carry content are encrypted (AES-256-GCM, AAD = table:row id).

-- Every stamped frame, in relay.seq order. `body` is the encrypted JSON of the stamped frame (original bytes' fields,
-- plus `relay`). `audience` says who may see it in a catch-up.
create table core_events (
  seq integer primary key autoincrement,
  frame_id text not null,
  type text not null,
  thread_id text,
  audience text not null check (audience in ('app', 'bridge', 'both')),
  counts_unread integer not null default 0,
  body blob not null,
  created_at integer not null
);
create unique index core_events_frame_id on core_events (frame_id);
create index core_events_thread on core_events (thread_id, seq);
create index core_events_created on core_events (created_at);

-- Bridge-bound durable frames not yet acked. The frame itself lives in core_events (same seq).
create table core_outbox (
  frame_id text primary key,
  seq integer not null,
  type text not null,
  consumable integer not null,
  delivered integer not null default 0,
  attempts integer not null default 0,
  next_try_at integer not null,
  created_at integer not null,
  expires_at integer not null
);
create index core_outbox_seq on core_outbox (seq);

-- Seen ids: 'cm:<client_msg_id>', 'of:<owner frame id>', 'bf:<bridge frame id>'. value = the seq it was stored under.
create table core_dedup (
  key text primary key,
  seq integer not null,
  created_at integer not null
);
create index core_dedup_created on core_dedup (created_at);

create table core_cards (
  card_id text primary key,
  thread_id text not null,
  state text not null,
  risk text not null,
  payload_hash text not null,
  expires_at integer not null,
  card blob not null,
  created_at integer not null
);
create index core_cards_state on core_cards (state, expires_at);

-- Agent-created threads (fast path). config.sync is authoritative once the Mac has synced.
create table core_threads (
  thread_id text primary key,
  thread blob not null,
  archived integer not null default 0,
  updated_at integer not null
);

create table core_status (
  thread_id text primary key,
  state text not null,
  label text,
  since integer not null,
  derived integer not null default 0
);

create table core_message_meta (
  message_id text primary key,
  thread_id text,
  receipt text,
  transcript blob,
  updated_at integer not null
);

create table core_read (
  thread_id text primary key,
  up_to_seq integer not null
);

create table core_state (
  key text primary key,
  value blob not null
);

create table core_media (
  media_id text primary key,
  mime text not null,
  name text not null,
  size integer not null,
  sha256 text not null,
  kind text not null,
  origin text not null check (origin in ('app', 'bridge')),
  duration_ms integer,
  evicted integer not null default 0,
  created_at integer not null
);
create index core_media_created on core_media (created_at);

create table core_push_subs (
  endpoint text primary key,
  sub blob not null,
  created_at integer not null
);
