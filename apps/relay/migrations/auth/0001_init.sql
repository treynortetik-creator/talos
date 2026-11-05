-- WP2 auth schema (spec 5.2 to 5.4). All timestamps are unix milliseconds.

-- The single owner. user_handle is the fixed WebAuthn userID (16 random bytes, created on first use).
create table auth_user (
  id integer primary key check (id = 1),
  user_handle blob not null,
  created_at integer not null
);

create table auth_credentials (
  credential_id text primary key,       -- base64url
  public_key blob not null,
  counter integer not null default 0,
  transports text,                      -- JSON array or null
  device_name text not null,
  created_at integer not null,
  last_used_at integer
);

-- Enrollment codes registered by the Mac (POST /bridge/enroll). Only sha256(code_auth) is stored.
create table auth_enroll_codes (
  code_id text primary key,             -- first 16 hex of code_auth_hash
  code_auth_hash text not null unique,
  label text,
  created_at integer not null,
  expires_at integer not null,
  used_at integer,                      -- set when the device half completes
  burned_at integer,                    -- set when the 5-failures rule fires
  registered_at integer,                -- set when this code registered a passkey (once)
  registered_credential_id text         -- the passkey it registered; only that passkey may finish half 2
);

-- Failed enroll/device-verify attempts (a wrong code_auth matches no code, so they are counted globally).
create table auth_enroll_failures (
  id integer primary key autoincrement,
  at integer not null
);

-- One row per storage jar that completed half 2. pinned flips when the Mac says y (device.pinned ok:true).
create table auth_devices (
  id text primary key,                  -- d_...
  name text not null,
  pubkey_jwk text not null,             -- JSON
  credential_id text,
  binding text not null,
  code_id text,
  pinned integer not null default 0,
  revoked integer not null default 0,
  created_at integer not null,
  last_used_at integer
);

create table auth_sessions (
  id text primary key,                  -- sha256 hex of the cookie value
  credential_id text,
  device_id text,
  created_at integer not null,
  last_seen_at integer not null,
  expires_at integer not null
);
create index auth_sessions_device on auth_sessions(device_id);
create index auth_sessions_credential on auth_sessions(credential_id);

-- Pending WebAuthn challenges: single use, short TTL. kind: reg | login | stepup.
create table auth_challenges (
  challenge text primary key,           -- base64url
  kind text not null,
  session_id text,
  purpose text,
  expires_at integer not null
);

-- Step-up tokens: sha256 only, bound to session + purpose, TTL 120 s, single use.
create table auth_stepup (
  token_hash text primary key,
  session_id text not null,
  purpose text not null,
  expires_at integer not null,
  used_at integer
);

-- Bridge keys. status active|previous; a previous key is valid until valid_until.
create table auth_bridge_keys (
  key_id text primary key,
  pubkey text not null,                 -- raw Ed25519, base64url
  status text not null check (status in ('active', 'previous')),
  created_at integer not null,
  valid_until integer
);

-- Nonces seen on bridge HTTP requests and on accepted bridge hellos (10 min).
create table auth_bridge_nonces (
  nonce text primary key,
  expires_at integer not null
);
create index auth_bridge_nonces_exp on auth_bridge_nonces(expires_at);
create index auth_challenges_exp on auth_challenges(expires_at);
