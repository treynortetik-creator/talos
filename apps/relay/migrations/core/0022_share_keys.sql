-- The `Idempotency-Key` of a share that was stored, with the share_id it was answered with, so a retry of the same
-- share (the reply was lost) is answered again instead of being stored twice. Per share token; pruned after two days
-- when the next one is written (core/share.ts).
create table core_share_keys (
  token_id text not null,
  idem_key text not null,
  share_id text not null,
  created_at integer not null,
  primary key (token_id, idem_key)
);
create index core_share_keys_at on core_share_keys (created_at);
