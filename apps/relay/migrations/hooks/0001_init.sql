-- Integrations: connections, durable inbound queue (raw payloads, encrypted), deliveries log, dedup, normalized events
-- with inbox state, one-time claim codes, poll cursors. All times are epoch milliseconds.

create table hooks_connections (
  id text primary key,
  integration text not null,
  name text not null,
  thread text not null,
  status text not null default 'active',
  paused_reason text,
  filters text not null default '{}',
  advanced text not null default '[]',
  extra text not null default '{}',
  secret_enc blob not null,
  old_secret_enc blob,
  old_secret_expires_at integer,
  creds_enc blob,
  created_at integer not null,
  last_event_at integer
);

-- Written before the 200 is sent. The worker normalizes from here, so a crash loses nothing. `headers` is base64 of an
-- AES-GCM blob (a Bearer secret rides in the request headers); order of processing is the implicit rowid.
create table hooks_inbound (
  id text primary key,
  conn_id text not null,
  delivery_id integer,
  received_at integer not null,
  headers text not null,
  raw_enc blob not null,
  state text not null default 'pending',
  attempts integer not null default 0
);
create index hooks_inbound_state on hooks_inbound (state, received_at);
create index hooks_inbound_conn on hooks_inbound (conn_id);

create table hooks_deliveries (
  id integer primary key autoincrement,
  conn_id text not null,
  at integer not null,
  status integer not null,
  reason text,
  received integer not null default 0,
  kept integer not null default 0
);
create index hooks_deliveries_conn on hooks_deliveries (conn_id, at);

create table hooks_dedup (
  key text primary key,
  seen_at integer not null,
  expires_at integer not null
);
create index hooks_dedup_expiry on hooks_dedup (expires_at);

create table hooks_events (
  event_id text primary key,
  conn_id text not null,
  integration text not null,
  thread text not null,
  priority text not null,
  work integer not null default 0,
  ts text not null,
  event_json text not null,
  state text not null default 'new',
  snooze_until text,
  agent_summary text,
  card_id text,
  raw_id text,
  collected integer not null default 0,
  digested_at integer,
  bridge_frame_id text,
  apps_sent_at integer, -- inbox.item / message.stored handed to the apps hub (durable pass, route.ts)
  sent_at integer, -- hook.event handed to the bridge, or the digest that carried it
  delivered_at integer,
  passthrough integer not null default 0,
  created_at integer not null
);
create index hooks_events_conn on hooks_events (conn_id, created_at);
create index hooks_events_created on hooks_events (created_at);
create index hooks_events_collected on hooks_events (collected, digested_at);
create index hooks_events_frame on hooks_events (bridge_frame_id);
create index hooks_events_snooze on hooks_events (state, snooze_until);

create table hooks_claims (
  conn_id text primary key,
  code_hash text not null,
  expires_at integer not null,
  attempts integer not null default 0,
  used_at integer
);

create table hooks_poll_state (
  conn_id text primary key,
  cursor text,
  next_at integer not null,
  fail_count integer not null default 0,
  last_error text
);
