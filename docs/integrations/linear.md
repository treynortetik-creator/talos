# Linear

Paste a personal API key; the app calls `webhookCreate` once (GraphQL, header `Authorization: <key>`, no `Bearer`) and keeps
only the webhook secret. Verification: `Linear-Signature` = hex HMAC-SHA256(secret, raw body); the body's
`webhookTimestamp` must be within 60 seconds; dedup on `Linear-Delivery`. Optional `user_id` marks issues assigned to you
(high priority); other issue changes are low and off by default.
