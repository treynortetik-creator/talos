-- The passkey step-up is gone (owner ruling 2026-11-14: "There should be zero Face ID approvals"): only sign-in keeps the
-- passkey. Its single-use tokens had nowhere left to be minted or checked.
drop table if exists auth_stepup;
