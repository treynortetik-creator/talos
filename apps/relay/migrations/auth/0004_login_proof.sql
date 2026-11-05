-- Item 3 (device-proof): when this device first signed in by proving its device key (signing the login challenge). Once set,
-- the relay never attaches this device to a sign-in again without such a proof, so an older client cannot be imitated by
-- simply leaving the proof out. Null for every existing device: they keep signing in until their first proven sign-in.
-- Additive, so a rolled-back build simply ignores the column.
alter table auth_devices add column login_proven_at integer;
