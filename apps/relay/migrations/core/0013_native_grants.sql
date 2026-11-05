-- Rich iPhone notifications. One row per phone: the grant its device key signed (`native.grant`), kept exactly as received.
-- It holds only public keys: the key the relay seals notification text to and the key that signs Reply / Approve. A revoked
-- or un-pinned device's row is ignored at read time (join on auth_devices), and sign-out deletes it.
create table core_native_grants (
  device_id text primary key,           -- d_...
  enc_pub text not null,                -- base64url, 65-byte P-256 point
  act_pub text not null,
  grant_json text not null,             -- the signed object, byte for byte
  exp integer not null,                 -- ms; the grant's own expiry
  created_at integer not null
);

-- Every native action id the relay has accepted, with the hash of the exact signed bytes. A retry of the same bytes is
-- answered as done; the same id with other bytes is refused. In the database, so a restart does not forget.
create table core_native_acts (
  act_key text primary key,             -- device id + ":" + action id
  body_hash text not null,
  seq integer not null,
  expires_at integer not null
);
