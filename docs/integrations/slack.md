# Slack (work)

Ships **disabled**. **Ask your IT team before connecting these.** A workplace admin controls which apps can be added to a
workspace; if Slack says "Request to install", an admin has to approve it.

## What it reads

Direct messages, group direct messages, and channel messages that mention you. Everything else is dropped by a
pre-filter right after the signature check, before anything is stored. Your own messages, edits, deletions and joins are
dropped too. The app asks for four user scopes and nothing else: `im:history`, `mpim:history`, `channels:history`,
`groups:history` (a channel message only matters when it mentions you, and Slack only delivers channel events with the
history scope). Names are not looked up, so events show Slack ids.

## Set up

1. Tap **Open Slack**. The app manifest link has the request URL and scopes filled in. Pick the workspace and **Create**.
2. In Slack open **App Manifest** and tap **Verify** next to the Request URL. The relay answers Slack's
   `url_verification` before any secret exists, so it goes green. Then **Install to Workspace**, **Allow**.
3. Paste the **Signing Secret** (Basic Information). That is the only thing asked for: no user token is collected, and your Slack id comes from the signed event itself.

## Verification

`X-Slack-Signature: v0=` + hex HMAC-SHA256(signing secret, `v0:{X-Slack-Request-Timestamp}:{raw body}`), compared in
constant time, rejected when more than 5 minutes old. A retry or replay carries the same `event_id`, which is the dedup
key, so it is stored once. The test suite includes Slack's published example (secret `8f74…85a5`, timestamp
`1531420618`).

The `url_verification` reply is `text/plain`, only for a short challenge made of letters, digits and `._~-`.
