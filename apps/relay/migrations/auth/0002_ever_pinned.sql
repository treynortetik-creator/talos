-- Whether the Mac ever said y to this device. A device that never was pinned and is then declined takes its passkey with it
-- (a stranger who saw one enrollment link); a device that WAS pinned and answers N to a repeat enrollment keeps it.
alter table auth_devices add column ever_pinned integer not null default 0;
update auth_devices set ever_pinned = 1 where pinned = 1;
