-- "Undo to here": an owner message's undo point ('ready', 'not_saved', 'too_large'), as the bridge put it on the message's
-- `delivered` receipt. Kept beside the receipt so a history row and a device that was away get it too.
alter table core_message_meta add column undo text;
