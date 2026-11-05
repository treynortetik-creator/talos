-- Native push (APNs, IOS-SPEC WP-I5). One row per phone: the APNs device token, sealed (AES-GCM, AAD = table + token
-- hash), under the device that registered it. `device_id` is unique, so a phone that gets a new token (reinstall,
-- restore) replaces its old row. A revoked or un-pinned device's row is ignored at send time (join on auth_devices).
create table core_push_devices (
  token_hash text primary key,          -- sha256 hex of the token (the token itself is only in `sealed`)
  device_id text not null unique,       -- d_...
  env text not null check (env in ('sandbox', 'production')),
  sealed blob not null,                 -- {"token": "<hex>"}
  created_at integer not null
);

-- Registration nonces seen in the last few minutes. In the database, not memory, so a relay restart inside the freshness
-- window does not make a captured registration valid again. Rows are pruned as they expire.
create table core_push_nonces (
  nonce_key text primary key,           -- device id + ":" + nonce
  expires_at integer not null
);

-- Opaque references the relay puts in an APNs payload in place of a thread id. An APNs request is TLS to Apple only, so a
-- thread's slug (made from the name the owner or an agent typed) must never ride in it; the app resolves the reference over
-- its signed-in connection after a tap (`GET /api/push/ref/:ref`). One stable reference per thread.
create table core_push_refs (
  thread_id text primary key,
  ref text not null unique,
  created_at integer not null
);
