-- "Why was that push plain?" One row per phone: how the latest message push to it left. Latest only, no history; the row is
-- replaced by the next push that STARTED later, and deleted with the phone's token (turn off, Apple's 410, a new token),
-- on sign-out and on revoke. `reason` is set only when the push went plain.
create table core_push_last (
  device_id text primary key,           -- d_...
  rich integer not null,                -- 1 = it carried the message text, 0 = the fixed phrase
  reason text,                          -- a code from RELAY_PLAIN_REASONS (packages/protocol/src/push.ts)
  seal_id text,                         -- the seal's id when the push left sealed: the phone's own report names it
  at integer not null                   -- ms on the relay's clock when the push started
);
