-- Why a session ended, so the app can tell "you were signed out for being idle" from "this device was revoked or signed
-- out everywhere". A row is kept for as long as a browser could still hold the old cookie. The device and credential are
-- kept so a revoke or a sign-out everywhere that comes AFTER an idle expiry can still rewrite the reason: a lost phone
-- must not be told "expired". Additive: an older build ignores it.
create table auth_session_ends (
  id text primary key,
  reason text not null,
  ended_at integer not null,
  device_id text,
  credential_id text
);
