# Google Calendar

An Apps Script in your Google account watches the next 14 days of your default calendar (a calendar-update trigger plus a
5-minute timer) and sends:

| Item             | When                                           | Priority |
| ---------------- | ---------------------------------------------- | -------- |
| `gcal.invite`    | a new event you are invited to                 | high     |
| `gcal.changed`   | title, time, location or your response changed | normal   |
| `gcal.starting`  | starts within 15 minutes (once)                | high     |
| `gcal.cancelled` | an event inside the window disappeared         | low      |

Install like Gmail: paste, choose `install`, **Run**, **Allow**. The first run records state silently. Signing is Standard
Webhooks over the exact bytes sent.

Known behaviours: the script keys an event by its id **and start time**, so a moved instance reads as a cancellation of the
old slot; a cancelled item carries no title ("An event was cancelled") because the script keeps none; the 80-event cap never
causes false cancellations; the state property is trimmed to stay under Google's 9 KB limit.
