# Calendly

Needs a paid plan. Paste a personal access token; the app reads your profile and registers a user-scope webhook
(`invitee.created`, `invitee.canceled`) with a signing key it generated. Verification: `Calendly-Webhook-Signature:
t=…,v1=…` = hex HMAC-SHA256(signing key, `{t}.{raw body}`), 3 minute window, dedup on `payload.uri` + event.
