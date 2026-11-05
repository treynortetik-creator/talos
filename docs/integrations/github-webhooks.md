# GitHub per-repo webhooks

> **Not available in v1.** The setup wizard has no repository step and the relay does not create per-repo hooks yet; this
> is planned for v1.1. Until then GitHub works through the notifications poll only ([github.md](github.md)). The rest of
> this page describes the planned design.

Optional, on top of the notifications poll in [github.md](github.md), for build alerts. With a **fine-grained** token
(Webhooks: read and write) the app creates one hook per ticked repo (`POST /repos/{owner}/{repo}/hooks`, events: issues,
issue_comment, pull_request, pull_request_review, pull_request_review_comment, workflow_run) and keeps the token until setup finishes
unless you tick auto-repair.

Verification: `X-Hub-Signature-256: sha256=` + hex HMAC-SHA256(secret, raw body), constant-time. GitHub sends no timestamp,
so replays are stopped by the `X-GitHub-Delivery` dedup key (kept 90 days). The test suite includes GitHub's published
vector.

Set your GitHub username on the connection (`login`): mentions, review requests and assignments are only recognised for
that user. Without it everything from a webhook is a low-priority `github.event`.
