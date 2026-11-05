# Stripe

Add an endpoint in the Stripe dashboard with the connection URL and the events checkout.session.completed, invoice.paid,
charge.dispute.created, customer.subscription.deleted, then paste its `whsec_…` signing secret. Verification:
`Stripe-Signature: t=…,v1=…` = hex HMAC-SHA256(secret, `{t}.{raw body}`); any `v1` may match, other schemes are ignored;
5 minute window; dedup on the event id. Disputes are high priority.

Creating the endpoint from a restricted key (`POST /v2/core/event_destinations`) is built, but its request body is
**INFERENCE from the spec and unverified against a real account**; the dashboard route above is the supported path.
