-- Wrong pairing codes are counted per client address, so a stranger's guesses lock out that address only (spec 5.2).
-- A wrong device proof on a code the caller holds also records that code's id, so the code burns on its own 5th wrong
-- proof from any mix of addresses. Rows written before this migration keep ip '' and no code, and age out of the 10-minute
-- window by themselves.
alter table auth_enroll_failures add column ip text not null default '';
alter table auth_enroll_failures add column code_id text;
create index auth_enroll_failures_ip_at on auth_enroll_failures (ip, at);
create index auth_enroll_failures_code on auth_enroll_failures (code_id);
