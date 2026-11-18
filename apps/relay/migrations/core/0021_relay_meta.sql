-- This relay's own id, minted once at first start (core/relay-descriptor.ts) and served in /.well-known/talos-relay.
-- One row (id = 1); never derived from any key.
create table core_relay_meta (id integer primary key check (id = 1), relay_id text not null, created_at text not null);
