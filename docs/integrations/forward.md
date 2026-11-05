# Forwarded email

Make one Gmail filter: **To** `you+talos@…` (your address with `+talos` before the @) → **Apply the label**
`Talos/Inbound`. Mail with that label reaches the agent in full (up to 4,000 characters) as `email.forwarded`, high
priority.

This connection has its own small Apps Script: the [Gmail](gmail.md) script with the inbox search removed, so it sends only
labelled mail. Install it the same way (claim code, `install`, **Run**, **Allow**). If you already connected Gmail, that
script picks up the same label, so you can skip this one; the two use separate dedup namespaces (`forward:` and `gmail:`),
so using both shows labelled mail twice.
