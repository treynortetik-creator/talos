# Zoom (work)

Ships **disabled**. **Ask your IT team before connecting these.** This needs a Zoom Marketplace app, which a workplace admin
will most likely have to approve; until then there is nothing to do.

Verification: `x-zm-signature: v0=` + hex HMAC-SHA256(secret token, `v0:{x-zm-request-timestamp}:{raw body}`), 5 minute
window, dedup on event + `payload.object.uuid`. URL validation (`endpoint.url_validation`) replies
`{plainToken, encryptedToken}` with `encryptedToken` = hex HMAC-SHA256(secret token, plainToken). The reply is only given for
a plain token of letters, digits, `_` and `-`: that stops anyone using the endpoint to compute a valid
`v0:{ts}:{body}` signature. Only `recording.completed` is used; download tokens and file URLs are never kept.
