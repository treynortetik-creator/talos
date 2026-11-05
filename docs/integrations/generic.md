# Any app (generic, Zapier, Make, n8n)

Anything that can send an HTTP POST can put a note in the Inbox. `zapier`, `make` and `n8n` are the same connection with
setup copy written for that tool.

## Sending

```
POST https://<your relay>/hook/generic/<connection id>
Authorization: Bearer <secret>
Content-Type: application/json

{ "title": "Deploy finished", "summary": "example-app is live.", "url": "https://example.com/deploys/118" }
```

The secret and the URL are shown once when you create the connection. Either header form works:

| Form              | Headers                                                | Notes                                                                                                                        |
| ----------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Bearer            | `Authorization: Bearer <secret>`                       | Easiest. No replay protection, so identical bodies are treated as one delivery for 7 days unless you send `Idempotency-Key`. |
| Standard Webhooks | `webhook-id`, `webhook-timestamp`, `webhook-signature` | HMAC-SHA256 over `{id}.{timestamp}.{raw body}`, 5 minute window, replays are dropped by `webhook-id`.                        |

## What lands in the Inbox

If the JSON has `title`, `summary` and `url` they are used as they are (a few common alternatives such as `subject`,
`message` and `link` are understood too). Otherwise open **Connection → Map fields** and enter JSON pointers, for example
`/issue/title`. `priority` (`high`, `normal`, `low`) and `ts` are honoured when present; the default priority is `low`, which
shows the item under **Other** without a push.

Links must be `http(s)`; anything else (`javascript:`, `data:`) is dropped and the item shows without a link.

## Limits and behaviour

- 1 MB body at most (413 above). More than 600 deliveries an hour to one connection are acknowledged and dropped.
- A wrong secret, bad signature or stale timestamp is a 401 with no explanation in the response; the reason is in
  **Recent deliveries** on the connection page.
- Rotating the secret keeps the old one valid for 24 hours.
