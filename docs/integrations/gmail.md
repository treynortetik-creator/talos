# Gmail

A small Google Apps Script in your own Google account checks for new mail every 5 minutes and sends it to your relay.
No Google API keys, no OAuth consent screen, no third party.

## Set up (about 3 minutes)

1. Create the Gmail connection in the app. It gives you a script with a one-time **claim code** inside.
2. Open Google Apps Script, **New project**, paste the script.
3. Choose `install` and **Run**. Google asks for permission (read your mail, call an external service): **Allow**.

The script trades the claim code for the signing secret on its first run. The code works once and expires after 30
minutes, so the pasted text never holds a live secret. If the claim fails, make a fresh script in the app.

## What it sends

Every 5 minutes: new messages matching the search (default `in:inbox category:primary`), with a 300 character preview.
Messages carrying the forward label (default `Talos/Inbound`) arrive with up to 4,000 characters and become
`email.forwarded` items with high priority. Each POST carries at most 50 messages. If more than 200 threads arrive in one
run, the newest 200 are sent and the Inbox shows "Some mail was skipped".

Signing uses the Standard Webhooks scheme over the exact bytes sent, so non-ASCII subjects verify.

## Filters

| Toggle        | Default | Meaning                                                                                  |
| ------------- | ------- | ---------------------------------------------------------------------------------------- |
| Primary inbox | on      | Mail that is not forwarded and not from a VIP. Off keeps only VIP and forwarded mail.    |
| VIPs          | on      | Addresses in the connection's VIP list are high priority and survive the Primary toggle. |
| Forwarded     | on      | Mail with the forward label.                                                             |

Mail in a Promotions, Social, Updates or Forums label is low priority.

## Quota

Consumer accounts allow 90 minutes of trigger runtime a day; this script runs about 288 times a day and each run should
take well under 18 seconds. Uninstall by running `uninstall` in the script, then delete the connection in the app.
