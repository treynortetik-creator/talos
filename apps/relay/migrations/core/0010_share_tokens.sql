-- Share-to-Talos tokens (docs/V2-FEATURES.md V4.3). A token can call ONE route (POST /api/share) and land ONE kind of row
-- (an Inbox message). Only sha256(secret) is stored; the secret is shown once at creation. A token belongs to the device
-- that made it: lookup joins auth_devices, so a revoked or un-pinned device's tokens stop working with no extra step.
create table core_share_tokens (
  id text primary key,                 -- sh_...
  label text not null,
  device_id text not null,
  scopes text not null,                -- JSON: ["text"] or ["text","files"]
  secret_hash text not null unique,    -- sha256 hex of the secret
  created_at integer not null,
  last_used_at integer,
  last_used_net text,                  -- IPv4 /24 or IPv6 /48, never the full address
  revoked_at integer
);
create index core_share_tokens_device on core_share_tokens (device_id);
