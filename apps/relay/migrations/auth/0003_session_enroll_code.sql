-- WP-N0: a session minted by POST /api/auth/enroll/session remembers which setup code made it (the code's public id, never
-- the code), so a second call with the same live code can delete the first session: one session per code. Null for every
-- passkey session. Additive, so a rolled-back build simply ignores the column.
alter table auth_sessions add column enroll_code_id text;
create index auth_sessions_enroll_code on auth_sessions(enroll_code_id);
