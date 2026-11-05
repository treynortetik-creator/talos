# GitHub (notifications)

The relay polls `GET /notifications` with a **classic** personal access token that has only the `notifications` scope.
That covers mentions, review requests and assignments in every repository you can see. The token is stored encrypted and
only ever sent to `api.github.com`.

- **Polling:** every 60 seconds at most. `X-Poll-Interval` from GitHub is honoured, and `If-Modified-Since` makes an
  unchanged poll a free `304`.
- **First poll:** only the last hour, so connecting does not replay old unread notifications.
- **Nothing is marked read.** Notifications stay unread on GitHub; the relay remembers what it has shown.
- **Kinds:** `github.mention`, `github.review_requested`, `github.assign`, `github.ci_failed` (high priority); everything
  else is `github.event` (low).
- **Filters:** Mentions, Review requests, Assigned and Failed builds are on; Everything else is off.
- **Failures:** ten failed polls in a row (an expired token is the usual cause) pause the connection and leave
  "GitHub polling paused: GitHub answered 401. Re-paste the token." in the Inbox.
- **Webhooks** (build alerts per repository) are not part of v1; they are planned for v1.1. Setup asks for the token only.
