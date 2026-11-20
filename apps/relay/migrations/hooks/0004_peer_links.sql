-- Linked agents, one-paste link: the single-use codes. Only the SHA-256 of the token is stored. `back_url` and the encrypted
-- `back_secret_enc` are what the other install sent when it redeemed; the secret is wiped when the Mac collects it.
create table hooks_peer_links (
  code_id text primary key not null,
  conn_id text not null,
  token_hash text not null,
  expires_at integer not null,
  state text not null check (state in ('open', 'redeemed', 'collected', 'expired')),
  redeemed_at integer,
  collected_at integer,
  back_url text,
  back_secret_enc blob,
  -- set when the same valid token reached the redeem route again after the code was used: someone else may hold it
  replayed integer not null default 0
);
create index hooks_peer_links_conn on hooks_peer_links (conn_id);
create unique index hooks_peer_links_one_open on hooks_peer_links (conn_id) where state = 'open';
