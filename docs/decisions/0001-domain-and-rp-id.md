# 0001. Domain and WebAuthn RP ID

Status: decided 2026-10-28.

## Decision

Version 1 runs on the free Railway host, `https://<service>.up.railway.app`. `PUBLIC_ORIGIN` and `RP_ID` (the exact host)
are environment variables.

## Why it matters

`up.railway.app` is on the Public Suffix List, so the RP ID is the full Railway host, not a parent domain. A WebAuthn
credential is bound to its RP ID. **Moving to a custom domain later voids every passkey and means re-enrolling every
device.**

## Re-enroll steps (after a domain change)

1. Set `PUBLIC_ORIGIN` and `RP_ID` to the new host and redeploy.
2. On the Mac: `talos-app enroll` prints a new link.
3. On each device: open the link, create the passkey (Face ID), let the device key be created and bound.
4. On the Mac: confirm each device at the `Pin "<name>" [<four words>]? [y/N]` prompt.
5. Revoke the old devices with `talos-app devices revoke <id>`.

`docs/deploy-railway.md` repeats the warning next to the domain step.
