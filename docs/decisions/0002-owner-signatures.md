# 0002. Owner signatures

Status: decided 2026-10-28.

## Context

The relay serves the PWA and stores the buffer. If it is compromised at the database or API level it must not be able to
make the agent think the owner said something.

## Decision

- The app creates an ECDSA P-256 device key per storage jar with `extractable: false` and keeps the `CryptoKey` in
  IndexedDB. `device_id = 'd_' + base32lower(sha256(spki))[0..20]`.
- Every owner frame is signed over `"talos-owner/v1\n" + device_id + "\n" + sha256Hex(jcs(frame without osig, relay,
  stepup_token))`. `osig` is the raw IEEE P1363 signature (64 bytes), base64url. DER is rejected.
- Sign and verify the raw JSON, never a zod-parsed value (defaults rewrite objects). Owner-frame schemas are strict and have
  no defaults.
- Pinning happens on the Mac, not the relay: the enrollment code is generated on the Mac; the phone sends only
  `HMAC(code_bind, device_id + "\n" + jcs(pubkey_jwk))`; the bridge recomputes it and asks the owner to confirm a four-word
  fingerprint before adding the device to `devices.json`.
- The bridge checks, for every owner frame: device pinned and not revoked; signature valid; `ts` within now+2 min and
  now-8 days; `id` and `client_msg_id` unseen (seen ids persist in `history.sqlite`).
- A frame that fails any check is dropped. There is no warn mode and no switch to relax it.

## Consequences

- A relay that serves malicious JavaScript still defeats this. See `docs/SECURITY.md`.
- Until a device is pinned, the app holds its owner frames locally.
