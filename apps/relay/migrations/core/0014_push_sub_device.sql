-- Browser and Home Screen push subscriptions now record the device that made them, so revoking or signing out a device
-- can end its pushes. Additive: rows from before this stay with a null device_id (they are still cleared by "sign out
-- everywhere"; no revoke can reach them because nothing says whose they are).
alter table core_push_subs add column device_id text;
create index core_push_subs_device on core_push_subs (device_id);
