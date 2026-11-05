-- Inbox and webhook event text, encrypted at rest. `event_enc` holds the event sealed with the relay's data key (AES-256-GCM,
-- bound to the event id). A sealed row leaves `event_json` empty. A row with plain `event_json` stays readable, and the
-- relay seals such rows 500 per housekeeping tick (src/hooks/event-seal.ts). Additive only: no column changes meaning,
-- nothing is dropped.
-- Rollback: the release that added this column reads both forms and wrote only plain text; the release after it started
-- sealing. Going back to the one before sealing is safe. Going back to a build older than the one that added this column
-- cannot read sealed rows (it would find `event_json` empty: the inbox fails to load and webhook delivery stops).
alter table hooks_events add column event_enc blob;
create index hooks_events_unsealed on hooks_events (event_id) where event_enc is null and event_json != '';
